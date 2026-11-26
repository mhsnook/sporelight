import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import { EDITORS_ID, NEWS_READER_ID } from '../shared/schema.ts'

const root = new URL('../', import.meta.url)
const migrations = readdirSync(new URL('migrations/', root)).sort()
const migration = (name: string) => readFileSync(new URL(`migrations/${name}`, root), 'utf8')

// D1 enforces foreign keys, so the stand-in does too.
function database(upTo?: string) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const name of migrations) {
    if (upTo && name >= upTo) break
    apply(db, name)
  }
  return db
}
// D1 applies each migration file in one transaction, so a deferred foreign key is checked at its end.
const apply = (db: DatabaseSync, name: string) => db.exec(`BEGIN; ${migration(name)}; COMMIT;`)
const all = (db: DatabaseSync, query: string) => db.prepare(query).all() as Record<string, any>[]
const count = (db: DatabaseSync, table: string) => all(db, `SELECT COUNT(*) AS n FROM ${table}`)[0].n as number

describe('0004_evidence_model', () => {
  const db = database('0004')
  db.exec(`
    INSERT INTO bodies (id, slug, name) VALUES ('b', 'b', 'Body');
    INSERT INTO deciders (id, slug, name, sort_name) VALUES ('ann', 'ann', 'Ann', 'Ann'), ('bob', 'bob', 'Bob', 'Bob');
    INSERT INTO questions (id, slug, body_id, parent_id, kind, title, short_title) VALUES
      ('policy', 'policy', 'b', NULL, 'position', 'Policy?', 'Policy'),
      ('bill', 'bill', 'b', 'policy', 'formal_act', 'Signed the bill?', 'Bill');
    INSERT INTO stances (id, question_id, decider_id, position, summary, updated_at) VALUES
      ('bill:ann', 'bill', 'ann', 'support', 'Cosponsor.', '2026-01-01'),
      ('policy:ann', 'policy', 'ann', 'support', 'Cosponsor.', '2026-01-01');
    INSERT INTO evidence (id, question_id, decider_id, kind, signals, quote, source_url, source_title, occurred_on, submission_id, created_at) VALUES
      ('e-ann-signed', 'bill', 'ann', 'formal_act', 'support', 'Cosponsored the bill.', 'https://record.example/bill', 'Official record', '2026-01-01', NULL, '2026-01-01T00:00:00Z'),
      ('e-bob-signed', 'bill', 'bob', 'formal_act', 'support', 'Cosponsored the bill.', 'https://record.example/bill', 'Official record', '2026-01-02', NULL, '2026-01-02T00:00:00Z'),
      ('e-bob-wavers', 'bill', 'bob', 'interview', 'mixed', 'I may take my name off it.', 'https://news.example/roundup', 'Roundup, as published', '2026-02-01', 's-approved', '2026-02-02T00:00:00Z'),
      ('e-ann-said', 'policy', 'ann', 'statement', 'support', 'I am for it.', 'https://news.example/roundup', 'Roundup, as published', '2026-02-01', NULL, '2026-02-03T00:00:00Z');
    INSERT INTO submissions (id, question_id, decider_id, origin, kind, signals, quote, source_url, source_title, occurred_on, submitter_note, status, review_note, created_at, reviewed_at) VALUES
      ('s-approved', 'bill', 'bob', 'public', 'interview', 'mixed', 'I might take my name off.', 'https://news.example/roundup', 'roundup, as typed', '2026-02-01', 'Minute 12.', 'approved', 'Checked.', '2026-02-01T10:00:00Z', '2026-02-02T00:00:00Z'),
      ('s-rejected', 'policy', 'bob', 'public', 'statement', 'oppose', 'Made up words.', 'https://blog.example/rumour', NULL, NULL, NULL, 'rejected', 'Unsourced.', '2026-02-04T00:00:00Z', '2026-02-05T00:00:00Z'),
      ('s-pending', 'policy', 'ann', 'public', 'statement', 'support', 'Pending words.', 'https://blog.example/rumour', 'Rumour blog', NULL, NULL, 'pending', NULL, '2026-02-06T00:00:00Z', NULL),
      ('s-lead', 'policy', 'bob', 'news_search', 'statement', NULL, 'A search excerpt.', 'https://wire.example/story', 'Wire story', NULL, 'Search excerpt, not a verified quote.', 'pending', NULL, '2026-02-07T00:00:00Z', NULL);
  `)
  db.exec(migration('0004_evidence_model.sql'))

  it('makes one source per distinct URL', () => {
    expect(all(db, `SELECT url, title, kind FROM sources ORDER BY url`)).toEqual([
      { url: 'https://blog.example/rumour', title: 'Rumour blog', kind: null },
      // An editor's published title wins over the one the submitter typed.
      { url: 'https://news.example/roundup', title: 'Roundup, as published', kind: null },
      { url: 'https://record.example/bill', title: 'Official record', kind: 'official_record' },
      { url: 'https://wire.example/story', title: 'Wire story', kind: null },
    ])
  })

  it('turns each evidence row into an act, a report and a reading with the same id', () => {
    expect(all(db, `SELECT a.id, a.decider_id, a.kind, a.occurred_on, a.body, s.url, p.url AS primary_url, r.question_id, r.position
      FROM acts a JOIN reports rep ON rep.id = a.id AND rep.act_id = a.id JOIN sources s ON s.id = rep.source_id
      JOIN readings r ON r.id = a.id AND r.act_id = a.id LEFT JOIN sources p ON p.id = a.primary_source_id ORDER BY a.id`)).toEqual([
      { id: 'e-ann-said', decider_id: 'ann', kind: 'statement', occurred_on: '2026-02-01', body: 'I am for it.', url: 'https://news.example/roundup', primary_url: null, question_id: 'policy', position: 'support' },
      { id: 'e-ann-signed', decider_id: 'ann', kind: 'formal_act', occurred_on: '2026-01-01', body: 'Cosponsored the bill.', url: 'https://record.example/bill', primary_url: 'https://record.example/bill', question_id: 'bill', position: 'support' },
      { id: 'e-bob-signed', decider_id: 'bob', kind: 'formal_act', occurred_on: '2026-01-02', body: 'Cosponsored the bill.', url: 'https://record.example/bill', primary_url: 'https://record.example/bill', question_id: 'bill', position: 'support' },
      { id: 'e-bob-wavers', decider_id: 'bob', kind: 'interview', occurred_on: '2026-02-01', body: 'I may take my name off it.', url: 'https://news.example/roundup', primary_url: null, question_id: 'bill', position: 'mixed' },
    ])
    expect(count(db, 'acts')).toBe(4)
    expect(count(db, 'reports')).toBe(4)
  })

  it('marks measures and copies only their supporting readings to the parent', () => {
    expect(all(db, `SELECT id, implies_parent_support, status FROM questions ORDER BY id`)).toEqual([
      { id: 'bill', implies_parent_support: 1, status: 'open' },
      { id: 'policy', implies_parent_support: 0, status: 'open' },
    ])
    expect(all(db, `SELECT act_id, question_id, position, via_question_id FROM readings WHERE via_question_id IS NOT NULL ORDER BY act_id`)).toEqual([
      { act_id: 'e-ann-signed', question_id: 'policy', position: 'support', via_question_id: 'bill' },
      { act_id: 'e-bob-signed', question_id: 'policy', position: 'support', via_question_id: 'bill' },
    ])
  })

  it('turns each submission into a proposal with one item', () => {
    expect(all(db, `SELECT p.id, p.origin, p.status, p.reviewed_at, s.url, i.id AS item_id, i.decider_id, i.question_id, i.kind, i.quote, i.reading, i.status AS item_status
      FROM proposals p JOIN sources s ON s.id = p.source_id JOIN proposal_items i ON i.proposal_id = p.id ORDER BY p.id`)).toEqual([
      { id: 's-approved', origin: 'reader', status: 'reviewed', reviewed_at: '2026-02-02T00:00:00Z', url: 'https://news.example/roundup', item_id: 's-approved', decider_id: 'bob', question_id: 'bill', kind: 'interview', quote: 'I might take my name off.', reading: 'mixed', item_status: 'accepted' },
      { id: 's-lead', origin: 'news_search', status: 'pending', reviewed_at: null, url: 'https://wire.example/story', item_id: 's-lead', decider_id: 'bob', question_id: 'policy', kind: 'statement', quote: 'A search excerpt.', reading: null, item_status: 'pending' },
      { id: 's-pending', origin: 'reader', status: 'pending', reviewed_at: null, url: 'https://blog.example/rumour', item_id: 's-pending', decider_id: 'ann', question_id: 'policy', kind: 'statement', quote: 'Pending words.', reading: 'support', item_status: 'pending' },
      { id: 's-rejected', origin: 'reader', status: 'reviewed', reviewed_at: '2026-02-05T00:00:00Z', url: 'https://blog.example/rumour', item_id: 's-rejected', decider_id: 'bob', question_id: 'policy', kind: 'statement', quote: 'Made up words.', reading: 'oppose', item_status: 'rejected' },
    ])
  })

  it('points an approved item at the act made from its evidence, and gives the others an id no act has', () => {
    const items = all(db, `SELECT i.id, i.act_id, (SELECT 1 FROM acts a WHERE a.id = i.act_id) AS on_file FROM proposal_items i ORDER BY i.id`)
    expect(items[0]).toEqual({ id: 's-approved', act_id: 'e-bob-wavers', on_file: 1 })
    expect(items.slice(1).map((i) => i.on_file)).toEqual([null, null, null])
    expect(new Set(items.map((i) => i.act_id)).size).toBe(4)
  })

  it('moves what was written for editors into notes', () => {
    expect(all(db, `SELECT proposal_id, kind, body FROM proposal_notes ORDER BY proposal_id, kind`)).toEqual([
      { proposal_id: 's-approved', kind: 'review', body: 'Checked.' },
      { proposal_id: 's-approved', kind: 'submitter', body: 'Minute 12.' },
      { proposal_id: 's-lead', kind: 'submitter', body: 'Search excerpt, not a verified quote.' },
      { proposal_id: 's-rejected', kind: 'review', body: 'Unsourced.' },
    ])
  })

  it('leaves stances alone, drops the old tables and breaks no reference', () => {
    expect(all(db, `SELECT id, position, summary FROM stances ORDER BY id`)).toEqual([
      { id: 'bill:ann', position: 'support', summary: 'Cosponsor.' },
      { id: 'policy:ann', position: 'support', summary: 'Cosponsor.' },
    ])
    expect(all(db, `SELECT name FROM sqlite_master WHERE name IN ('evidence', 'submissions')`)).toEqual([])
    expect(all(db, `PRAGMA foreign_key_check`)).toEqual([])
  })
})

describe('0006_shared_questions_and_roles_at_large', () => {
  const db = database('0006')
  db.exec(`
    INSERT INTO bodies (id, slug, name) VALUES ('b', 'b', 'Body');
    INSERT INTO deciders (id, slug, name, sort_name) VALUES ('ann', 'ann', 'Ann', 'Ann');
    INSERT INTO questions (id, slug, body_id, kind, title, short_title) VALUES ('ask', 'ask', 'b', 'position', 'Ask?', 'Ask');
    INSERT INTO offices (id, body_id, chamber, label, sort) VALUES ('chair', 'b', 'Upper', 'Chair', 3);
    INSERT INTO office_holders (id, office_id, decider_id, starts_on, ends_on) VALUES ('chair:ann', 'chair', 'ann', NULL, '2027-01-03');
    INSERT INTO question_offices (id, question_id, office_id) VALUES ('ask:chair', 'ask', 'chair');
  `)
  db.exec(migration('0006_shared_questions_and_roles_at_large.sql'))

  it('rebuilds offices without losing rows or the rows that point at them', () => {
    expect(all(db, `SELECT o.id, o.body_id, o.chamber, o.label, o.sort, h.decider_id, h.ends_on, h.source_id, l.question_id
      FROM offices o JOIN office_holders h ON h.office_id = o.id JOIN question_offices l ON l.office_id = o.id`)).toEqual([
      { id: 'chair', body_id: 'b', chamber: 'Upper', label: 'Chair', sort: 3, decider_id: 'ann', ends_on: '2027-01-03', source_id: null, question_id: 'ask' },
    ])
    expect(all(db, `PRAGMA foreign_key_check`)).toEqual([])
    expect(all(db, `SELECT name FROM sqlite_master WHERE name LIKE 'offices_new' OR name LIKE '%_aside'`)).toEqual([])
  })

  it('allows a role with no body, and still refuses a holder of an office that does not exist', () => {
    db.exec(`INSERT INTO offices (id, body_id, label) VALUES ('at-large', NULL, 'Fundraiser')`)
    expect(() => db.exec(`INSERT INTO office_holders (id, office_id, decider_id) VALUES ('x', 'nope', 'ann')`)).toThrow(/FOREIGN KEY/)
  })
})

describe('0007_act_nature', () => {
  const db = database('0007')
  db.exec(`
    INSERT INTO bodies (id, slug, name) VALUES ('b', 'b', 'Body');
    INSERT INTO deciders (id, slug, name, sort_name) VALUES ('ann', 'ann', 'Ann', 'Ann');
    INSERT INTO questions (id, slug, body_id, parent_id, kind, title, short_title, implies_parent_support) VALUES
      ('policy', 'policy', 'b', NULL, 'position', 'Policy?', 'Policy', 0),
      ('bill', 'bill', 'b', 'policy', 'formal_act', 'Bill?', 'Bill', 1);
    INSERT INTO sources (id, url, created_at) VALUES ('post', 'https://x.example/1', 't'), ('radio', 'https://x.example/2', 't'), ('paper', 'https://x.example/3', 't');
    INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES
      ('cosponsored', 'ann', 'formal_act', '2026-01-01', 'b', 't'), ('voted', 'ann', 'vote', '2026-01-02', 'b', 't'),
      ('posted', 'ann', 'social', '2026-01-03', 'b', 't'), ('interviewed', 'ann', 'interview', '2026-01-04', 'b', 't'),
      ('said', 'ann', 'statement', '2026-01-05', 'b', 't'), ('platform', 'ann', 'platform', '2026-01-06', 'b', 't');
    INSERT INTO reports (id, source_id, act_id, created_at) VALUES ('r1', 'post', 'posted', 't'), ('r2', 'radio', 'interviewed', 't'), ('r3', 'paper', 'said', 't');
    INSERT INTO readings (id, act_id, question_id, position, created_at) VALUES ('rd', 'cosponsored', 'bill', 'support', 't');
    INSERT INTO proposals (id, source_id, origin, created_at) VALUES ('p', 'paper', 'reader', 't');
    INSERT INTO proposal_items (id, proposal_id, decider_id, question_id, act_id, kind, quote) VALUES ('i1', 'p', 'ann', 'bill', 'a', 'formal_act', 'q'), ('i2', 'p', 'ann', 'policy', 'b', 'interview', 'q');
  `)
  db.exec(migration('0007_act_nature.sql'))

  it('turns each kind into how much the act binds', () => {
    expect(Object.fromEntries(all(db, `SELECT id, kind FROM acts`).map((a) => [a.id, a.kind]))).toEqual({
      cosponsored: 'commits',
      voted: 'does',
      posted: 'says',
      interviewed: 'says',
      said: 'says',
      platform: 'says',
    })
    expect(all(db, `SELECT id, kind, bearing FROM proposal_items ORDER BY id`)).toEqual([
      { id: 'i1', kind: 'commits', bearing: 'direct' },
      { id: 'i2', kind: 'says', bearing: 'direct' },
    ])
  })

  it('keeps where it was said on the source', () => {
    expect(all(db, `SELECT id, kind FROM sources ORDER BY id`)).toEqual([
      { id: 'paper', kind: null },
      { id: 'post', kind: 'social_post' },
      { id: 'radio', kind: 'transcript' },
    ])
  })

  it('carries the yes/no flag over as support, and reads every existing reading as direct', () => {
    expect(all(db, `SELECT id, implies_on_parent FROM questions ORDER BY id`)).toEqual([
      { id: 'bill', implies_on_parent: 'support' },
      { id: 'policy', implies_on_parent: null },
    ])
    expect(all(db, `SELECT bearing FROM readings`)).toEqual([{ bearing: 'direct' }])
    expect(all(db, `PRAGMA foreign_key_check`)).toEqual([])
  })

  it('refuses the old kinds', () => {
    expect(() => db.exec(`INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES ('x', 'ann', 'vote', '2026-01-01', 'b', 't')`)).toThrow(/CHECK/)
  })
})

describe('0009_one_kind_of_claim', () => {
  const db = database('0009')
  db.exec(`
    INSERT INTO bodies (id, slug, name, next_term_on) VALUES ('council', 'council', 'Council', NULL), ('house', 'house', 'House', '2027-01-03');
    INSERT INTO deciders (id, slug, name, sort_name) VALUES ('inc', 'inc', 'Inc', 'Inc'), ('cha', 'cha', 'Cha', 'Cha'), ('pri', 'pri', 'Pri', 'Pri');
    INSERT INTO seats (id, body_id, label, next_election_on) VALUES ('ward', 'council', 'Ward', '2027-05-04'), ('district', 'house', 'District', NULL);
    INSERT INTO roles (id, seat_id, decider_id, kind, contest, affiliation) VALUES
      ('r1', 'ward', 'inc', 'incumbent', NULL, 'A'), ('r2', 'ward', 'cha', 'challenger', 'general', 'B'), ('r3', 'district', 'pri', 'challenger', 'primary', 'A');
  `)
  db.exec(migration('0009_one_kind_of_claim.sql'))

  it('turns a challenger into a possible holder from the next election or term, and leaves a holder alone', () => {
    expect(all(db, `SELECT id, contest, starts_on, ends_on, certainty, affiliation FROM roles ORDER BY id`)).toEqual([
      { id: 'r1', contest: null, starts_on: null, ends_on: null, certainty: 'certain', affiliation: 'A' },
      { id: 'r2', contest: 'general', starts_on: '2027-05-04', ends_on: null, certainty: 'possible', affiliation: 'B' },
      { id: 'r3', contest: 'primary', starts_on: '2027-01-03', ends_on: null, certainty: 'possible', affiliation: 'A' },
    ])
    expect(all(db, `SELECT name FROM pragma_table_info('roles') WHERE name IN ('kind', 'depends_on')`)).toEqual([])
  })

  it('accepts the stages after election day as contests', () => {
    db.exec(`INSERT INTO roles (id, seat_id, decider_id, contest, certainty) VALUES ('r4', 'ward', 'pri', 'recount', 'likely')`)
    expect(() => db.exec(`INSERT INTO roles (id, seat_id, decider_id, contest) VALUES ('r5', 'ward', 'pri', 'coin toss')`)).toThrow(/CHECK/)
  })
})

describe('0012_review_model', () => {
  const db = database('0012')
  db.exec(`
    INSERT INTO bodies (id, slug, name) VALUES ('b', 'b', 'Body');
    INSERT INTO deciders (id, slug, name, sort_name) VALUES ('ann', 'ann', 'Ann', 'Ann');
    INSERT INTO questions (id, slug, body_id, parent_id, kind, title, short_title, implies_on_parent) VALUES
      ('policy', 'policy', 'b', NULL, 'position', 'Policy?', 'Policy', NULL),
      ('bill', 'bill', 'b', 'policy', 'formal_act', 'Bill?', 'Bill', 'support'),
      ('letter', 'letter', 'b', 'policy', 'formal_act', 'Letter?', 'Letter', 'lean_oppose');
    INSERT INTO sources (id, url, created_at) VALUES ('paper', 'https://x.example/1', 't');
    INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES
      ('said', 'ann', 'says', '2026-01-01', 'b', 't'), ('signed', 'ann', 'commits', '2026-01-02', 'b', 't'), ('voted', 'ann', 'does', '2026-01-03', 'b', 't'),
      ('aside', 'ann', 'says', '2026-01-04', 'b', 't'), ('other-vote', 'ann', 'does', '2026-01-05', 'b', 't'),
      ('hedged', 'ann', 'says', '2026-01-06', 'b', 't'), ('hinted', 'ann', 'says', '2026-01-07', 'b', 't'), ('voted-to-delay', 'ann', 'does', '2026-01-08', 'b', 't');
    INSERT INTO reports (id, source_id, act_id, excerpt, created_at) VALUES ('rep', 'paper', 'said', 'As printed.', 't');
    INSERT INTO readings (id, act_id, question_id, position, bearing, via_question_id, created_at) VALUES
      ('r-said', 'said', 'policy', 'support', 'direct', NULL, 't'),
      ('r-signed', 'signed', 'bill', 'support', 'direct', NULL, 't'),
      ('r-signed-parent', 'signed', 'policy', 'support', 'direct', 'bill', 't'),
      ('r-voted', 'voted', 'policy', 'oppose', 'direct', NULL, 't'),
      ('r-aside', 'aside', 'policy', 'mixed', 'indirect', NULL, 't'),
      ('r-other-vote', 'other-vote', 'policy', 'support', 'indirect', NULL, 't'),
      ('r-hedged', 'hedged', 'policy', 'lean_oppose', 'direct', NULL, 't'),
      ('r-hinted', 'hinted', 'policy', 'lean_oppose', 'indirect', NULL, 't'),
      ('r-voted-to-delay', 'voted-to-delay', 'policy', 'lean_oppose', 'direct', NULL, 't');
    INSERT INTO stances (id, question_id, decider_id, position, summary, updated_at) VALUES ('policy:ann', 'policy', 'ann', 'lean_support', 'Judged by an editor.', 't');
    INSERT INTO proposals (id, source_id, origin, status, created_at) VALUES ('p', 'paper', 'model', 'reviewed', 't'), ('lead', 'paper', 'news_search', 'pending', 't');
    INSERT INTO proposal_items (id, proposal_id, decider_id, question_id, act_id, kind, quote, reading, bearing, position, summary) VALUES
      ('i-says', 'p', 'ann', 'policy', 'a1', 'says', 'q', 'support', 'direct', 'support', 'For it.'),
      ('i-commits', 'p', 'ann', 'bill', 'a2', 'commits', 'q', 'support', 'direct', NULL, NULL),
      ('i-does', 'p', 'ann', 'policy', 'a3', 'does', 'q', 'oppose', 'direct', NULL, NULL),
      ('i-indirect', 'p', 'ann', 'policy', 'a4', 'does', 'q', 'support', 'indirect', NULL, NULL),
      ('i-lean', 'p', 'ann', 'policy', 'a5', 'says', 'q', 'lean_oppose', 'direct', 'lean_oppose', NULL),
      ('i-lean-does', 'p', 'ann', 'policy', 'a6', 'does', 'q', 'lean_oppose', 'direct', NULL, NULL),
      ('i-lead', 'lead', 'ann', 'policy', 'a7', 'says', 'A search excerpt.', NULL, 'direct', NULL, NULL);
  `)
  db.exec(migration('0012_review_model.sql'))
  const columns = (table: string) => all(db, `SELECT name FROM pragma_table_info('${table}')`).map((c) => c.name)

  it('gives each reading a weight in place of its bearing: indirect is passing, a commitment or use of office concrete, words clear', () => {
    expect(Object.fromEntries(all(db, `SELECT id, weight FROM readings WHERE id IN ('r-said', 'r-signed', 'r-signed-parent', 'r-voted', 'r-aside', 'r-other-vote')`).map((r) => [r.id, r.weight]))).toEqual({
      'r-said': 'clear',
      'r-signed': 'concrete',
      'r-signed-parent': 'concrete',
      'r-voted': 'concrete',
      'r-aside': 'passing',
      'r-other-vote': 'passing',
    })
    expect(columns('readings')).not.toContain('bearing')
  })

  it('turns a reading that leaned against into a passing reading against, and leaves a concrete one concrete', () => {
    expect(all(db, `SELECT id, position, weight FROM readings WHERE id IN ('r-hedged', 'r-hinted', 'r-voted-to-delay') ORDER BY id`)).toEqual([
      { id: 'r-hedged', position: 'oppose', weight: 'passing' },
      { id: 'r-hinted', position: 'oppose', weight: 'passing' },
      { id: 'r-voted-to-delay', position: 'oppose', weight: 'concrete' },
    ])
    expect(all(db, `SELECT position, via_question_id FROM readings WHERE id IN ('r-said', 'r-signed-parent', 'r-aside') ORDER BY id`)).toEqual([
      { position: 'mixed', via_question_id: null },
      { position: 'support', via_question_id: null },
      { position: 'support', via_question_id: 'bill' },
    ])
  })

  it('gives every proposal item that claims a reading a weight by the same rule, and a lead none', () => {
    expect(all(db, `SELECT id, reading, weight FROM proposal_items ORDER BY id`)).toEqual([
      { id: 'i-commits', reading: 'support', weight: 'concrete' },
      { id: 'i-does', reading: 'oppose', weight: 'concrete' },
      { id: 'i-indirect', reading: 'support', weight: 'passing' },
      { id: 'i-lead', reading: null, weight: null },
      { id: 'i-lean', reading: 'oppose', weight: 'passing' },
      { id: 'i-lean-does', reading: 'oppose', weight: 'concrete' },
      { id: 'i-says', reading: 'support', weight: 'clear' },
    ])
  })

  it('drops what a proposal item no longer carries and adds the passage, empty', () => {
    const names = columns('proposal_items')
    for (const gone of ['bearing', 'position', 'summary']) expect(names).not.toContain(gone)
    expect(all(db, `SELECT DISTINCT passage FROM proposal_items`)).toEqual([{ passage: null }])
  })

  it('leaves no question implying a lean against on its parent, which a reading can no longer be', () => {
    expect(all(db, `SELECT id, implies_on_parent FROM questions ORDER BY id`)).toEqual([
      { id: 'bill', implies_on_parent: 'support' },
      { id: 'letter', implies_on_parent: 'oppose' },
      { id: 'policy', implies_on_parent: null },
    ])
  })

  it('drops stances and carries none over as a position set by hand', () => {
    expect(all(db, `SELECT name FROM sqlite_master WHERE name = 'stances'`)).toEqual([])
    expect(count(db, 'set_positions')).toBe(0)
  })

  it('adds the new columns empty, keeps every row and breaks no reference', () => {
    expect(all(db, `SELECT excerpt, passage FROM reports`)).toEqual([{ excerpt: 'As printed.', passage: null }])
    expect(all(db, `SELECT id, unread FROM proposals ORDER BY id`)).toEqual([
      { id: 'lead', unread: null },
      { id: 'p', unread: null },
    ])
    expect(all(db, `SELECT DISTINCT decides_on FROM questions`)).toEqual([{ decides_on: null }])
    expect([count(db, 'readings'), count(db, 'proposal_items')]).toEqual([9, 7])
    expect(all(db, `PRAGMA foreign_key_check`)).toEqual([])
  })

  it('refuses a weight outside the three, and a second set position for one person on one question', () => {
    expect(() => db.exec(`INSERT INTO readings (id, act_id, question_id, position, weight, created_at) VALUES ('x', 'said', 'bill', 'support', 'heavy', 't')`)).toThrow(/CHECK/)
    expect(() => db.exec(`INSERT INTO proposal_items (id, proposal_id, decider_id, question_id, act_id, quote, weight) VALUES ('x', 'p', 'ann', 'policy', 'a', 'q', 'direct')`)).toThrow(/CHECK/)
    db.exec(`INSERT INTO set_positions (id, question_id, decider_id, position, reason, set_at) VALUES ('policy:ann', 'policy', 'ann', 'lean_oppose', 'Said so.', 't')`)
    expect(() => db.exec(`INSERT INTO set_positions (id, question_id, decider_id, position, reason, set_at) VALUES ('again', 'policy', 'ann', 'support', 'Said so.', 't')`)).toThrow(/UNIQUE/)
  })

  it('links two questions once, as a smaller step or as related', () => {
    db.exec(`INSERT INTO question_relations (id, question_id, related_id, kind) VALUES ('policy>bill', 'policy', 'bill', 'smaller_step')`)
    expect(() => db.exec(`INSERT INTO question_relations (id, question_id, related_id, kind) VALUES ('again', 'policy', 'bill', 'related')`)).toThrow(/UNIQUE/)
    expect(() => db.exec(`INSERT INTO question_relations (id, question_id, related_id, kind) VALUES ('x', 'bill', 'policy', 'bigger_step')`)).toThrow(/CHECK/)
    expect(() => db.exec(`INSERT INTO question_relations (id, question_id, related_id, kind) VALUES ('y', 'policy', 'gone', 'related')`)).toThrow(/FOREIGN KEY/)
  })
})

describe('the seed', () => {
  let seed = ''
  beforeAll(() => {
    execFileSync(process.execPath, [new URL('scripts/build-seed.ts', root).pathname], { stdio: 'ignore' })
    seed = readFileSync(new URL('seed/out/seed.sql', root), 'utf8')
  })

  it('loads into the migrated schema, and loads again without duplicating anything', () => {
    const db = database()
    db.exec(seed)
    const tables = ['sources', 'acts', 'reports', 'reviews', 'set_positions', 'question_relations', 'questions', 'question_deciders', 'offices', 'office_holders', 'question_offices', 'question_bodies', 'bodies', 'seats', 'roles']
    const first = tables.map((t) => count(db, t))
    expect(count(db, 'acts')).toBeGreaterThan(0)
    expect(count(db, 'reports')).toBe(count(db, 'acts'))
    db.exec(seed)
    expect(tables.map((t) => count(db, t))).toEqual(first)
    expect(all(db, `PRAGMA foreign_key_check`)).toEqual([])
  })

  it('holds no demo body', () => {
    const db = database()
    db.exec(seed)
    expect(all(db, `SELECT id FROM bodies WHERE is_demo = 1`)).toEqual([])
    expect(all(db, `SELECT url FROM sources WHERE url LIKE '%example.com%'`)).toEqual([])
  })

  it('accounts for each member of Halifax Regional Council once in its ferry fare vote', () => {
    const db = database()
    db.exec(seed)
    const votes = all(db, `SELECT r.position, COUNT(*) AS n FROM reviews r JOIN acts a ON a.id = r.act_id
      WHERE r.question_id = 'halifax-ferry-fares' AND a.kind = 'does' GROUP BY r.position ORDER BY r.position`)
    expect(votes).toEqual([{ position: 'oppose', n: 11 }, { position: 'support', n: 3 }])
    expect(all(db, `SELECT COUNT(*) AS n FROM seats WHERE body_id = 'halifax-regional-council'`)[0].n).toBe(17)
    expect(all(db, `SELECT COUNT(DISTINCT a.decider_id) AS n FROM acts a JOIN reviews r ON r.act_id = a.id WHERE r.question_id = 'halifax-ferry-fares' AND a.kind = 'does'`)[0].n).toBe(14)
    expect(all(db, `SELECT COUNT(*) AS n FROM acts a JOIN reviews r ON r.act_id = a.id WHERE r.question_id = 'halifax-ferry-fares' AND a.primary_source_id IS NOT NULL`)[0].n).toBe(0)
  })

  describe('seed/remove-demo.sql', () => {
    const removeDemo = readFileSync(new URL('seed/remove-demo.sql', root), 'utf8')
    const tables = ['bodies', 'seats', 'roles', 'deciders', 'questions', 'set_positions', 'question_relations', 'question_deciders', 'question_bodies', 'question_offices', 'offices', 'office_holders', 'sources', 'acts', 'reports', 'reviews', 'proposals', 'proposal_items', 'proposal_notes', 'proposal_contexts', 'proposal_mentions', 'comments', 'article_reads', 'archive_attempts']
    const counts = (db: DatabaseSync) => Object.fromEntries(tables.map((t) => [t, count(db, t)]))

    it('takes out a demo council and what readers added to it, and leaves every other row', () => {
      const db = database()
      db.exec(seed)
      // A real source a demo act also cites, and a real person's thread, both of which stay.
      db.exec(`
        INSERT INTO auth_users (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('u', '', 'u@reader.test', 1, '2026-11-01', '2026-11-01');
        INSERT INTO people (id, created_at) VALUES ('u', '2026-11-01');
        INSERT INTO comments (id, thread_id, person_id, body, created_at) VALUES ('c-real', 'm4a:' || (SELECT id FROM deciders WHERE id NOT LIKE 'demo-%' LIMIT 1), 'u', 'B', '2026-11-01');
      `)
      const before = counts(db)
      const sharedSource = all(db, `SELECT id FROM sources LIMIT 1`)[0].id
      db.exec(readFileSync(new URL('seed/out/e2e-fixture.sql', root), 'utf8'))
      db.exec(`
        INSERT INTO sources (id, url, created_at) VALUES ('src-reader', 'https://example.com/harbor-ledger/sato', '2026-11-01');
        INSERT INTO proposals (id, source_id, origin, created_at) VALUES ('p-demo', 'src-reader', 'reader', '2026-11-01');
        INSERT INTO proposal_items (id, proposal_id, decider_id, question_id, act_id, excerpt) VALUES ('i-demo', 'p-demo', 'demo-bartholomew-sato', 'free-ferry', NULL, 'Words.');
        INSERT INTO proposal_notes (id, proposal_id, proposal_item_id, kind, body, created_at) VALUES ('n-item', 'p-demo', 'i-demo', 'submitter', 'Note.', '2026-11-01'), ('n-whole', 'p-demo', NULL, 'submitter', 'Note.', '2026-11-01');
        INSERT INTO proposal_contexts (id, proposal_id, proposal_item_id, before, after) VALUES ('x-demo', 'p-demo', 'i-demo', 'Before.', 'After.');
        INSERT INTO proposal_mentions (id, proposal_id, decider_id, words) VALUES ('m-demo', 'p-demo', 'demo-bartholomew-sato', 'Named.');
        INSERT INTO comments (id, thread_id, person_id, body, created_at) VALUES ('c-demo', 'free-ferry:demo-bartholomew-sato', 'u', 'B', '2026-11-01');
        INSERT INTO article_reads (source_id, question_id, read_at, outcome) VALUES ('src-reader', 'free-ferry', '2026-11-01', 'no_acts');
        INSERT INTO archive_attempts (source_id, tried_at, outcome) VALUES ((SELECT id FROM sources WHERE url = 'https://example.com/harbor-city/1'), '2026-11-01', 'gave_up');
        INSERT INTO reports (id, source_id, act_id, created_at) VALUES ('rep-shared', '${sharedSource}', 'demo-e1', '2026-11-01');
      `)
      expect(count(db, 'bodies')).toBeGreaterThan(before.bodies)
      db.exec(removeDemo)
      expect(counts(db)).toEqual(before)
      expect(all(db, `PRAGMA foreign_key_check`)).toEqual([])
      expect(all(db, `SELECT name FROM sqlite_master WHERE name LIKE 'removed_%'`)).toEqual([])
    })

    it('changes nothing in a database with no demo body, and can run again', () => {
      const db = database()
      db.exec(seed)
      const before = counts(db)
      db.exec(removeDemo)
      db.exec(removeDemo)
      expect(counts(db)).toEqual(before)
    })
  })

  it('finds the source a database already holds for a URL instead of adding another', () => {
    const db = database()
    const url = /INSERT INTO sources \(id, url, title, kind, created_at\) VALUES \('[^']+', '([^']+)'/.exec(seed)![1]
    db.prepare(`INSERT INTO sources (id, url, created_at) VALUES ('held', ?, '2026-01-01')`).run(url)
    db.exec(seed)
    expect(all(db, `SELECT id FROM sources WHERE url = '${url}'`)).toEqual([{ id: 'held' }])
    expect(all(db, `SELECT COUNT(*) AS n FROM reports WHERE source_id = 'held'`)[0].n).toBeGreaterThan(0)
  })

  it("writes every seeded reading as the editors' review", () => {
    const db = database()
    db.exec(seed)
    expect(count(db, 'reviews')).toBeGreaterThan(0)
    expect(all(db, `SELECT DISTINCT reviewer_id FROM reviews`)).toEqual([{ reviewer_id: EDITORS_ID }])
  })

  it('seeds an open ask of an office in Congress, with a holder now and one from the next term', () => {
    const db = database()
    db.exec(seed)
    expect(all(db, `SELECT q.parent_id, q.status, q.implies_on_parent, o.label, b.next_term_on FROM questions q
      JOIN question_offices l ON l.question_id = q.id JOIN offices o ON o.id = l.office_id JOIN bodies b ON b.id = o.body_id WHERE q.id = 'm4a-s1506-markup'`)).toEqual([
      { parent_id: 'm4a', status: 'open', implies_on_parent: null, label: 'Chair, Senate Finance Committee', next_term_on: '2027-01-03' },
    ])
    expect(all(db, `SELECT d.name, h.starts_on, h.ends_on FROM office_holders h JOIN deciders d ON d.id = h.decider_id
      WHERE h.office_id = 'us-senate-finance-chair' ORDER BY h.starts_on IS NOT NULL`)).toEqual([
      { name: 'Mike Crapo', starts_on: null, ends_on: '2027-01-03' },
      { name: 'Ron Wyden', starts_on: '2027-01-03', ends_on: null },
    ])
    expect(all(db, `SELECT COUNT(*) AS n FROM reviews WHERE question_id = 'm4a-s1506-markup'`)[0].n).toBe(0)
  })

  it('moves an ask that named a person onto its office when the asks file is replayed alone', () => {
    const db = database()
    db.exec(seed)
    db.exec(`INSERT INTO question_deciders (id, question_id, decider_id, role_label) VALUES ('m4a-s1506-markup:W000779', 'm4a-s1506-markup', 'W000779', 'Ranking Member, Senate Finance Committee')`)
    db.exec(readFileSync(new URL('seed/out/us-congress-asks.sql', root), 'utf8'))
    expect(all(db, `SELECT COUNT(*) AS n FROM question_deciders WHERE question_id = 'm4a-s1506-markup'`)[0].n).toBe(0)
    expect(all(db, `PRAGMA foreign_key_check`)).toEqual([])
  })

  it('keeps a person an editor added to a seeded ask when the asks file is replayed', () => {
    const db = database()
    db.exec(seed)
    db.exec(`INSERT INTO question_deciders (id, question_id, decider_id, role_label) VALUES ('3b1f0c9e-7a52-4d0e-9c41-5e2a8f6d1b77', 'm4a-s1506-markup', 'W000779', NULL)`)
    db.exec(readFileSync(new URL('seed/out/us-congress-asks.sql', root), 'utf8'))
    expect(all(db, `SELECT decider_id FROM question_deciders WHERE question_id = 'm4a-s1506-markup'`)).toEqual([{ decider_id: 'W000779' }])
  })

  it('keeps a person an editor added, and their role on a seeded seat, when the seed is replayed', () => {
    const db = database()
    db.exec(seed)
    db.exec(`INSERT INTO deciders (id, slug, name, sort_name, external_id, url) VALUES ('9d2c4e1a-5b7f-4a60-8e3d-2f1b6c0a9e44', 'rosa-delgado-challenger', 'Rosa Delgado', 'Delgado, Rosa', NULL, NULL);
      INSERT INTO roles (id, seat_id, decider_id, contest, affiliation, starts_on, ends_on, certainty) VALUES ('6a0e8f3b-1c2d-4e5f-9a7b-3c4d5e6f7a8b', 'us-congress:CA-12', '9d2c4e1a-5b7f-4a60-8e3d-2f1b6c0a9e44', 'general', 'Green', '2027-01-03', NULL, 'possible');`)
    db.exec(seed)
    expect(all(db, `SELECT r.seat_id, d.name FROM roles r JOIN deciders d ON d.id = r.decider_id WHERE r.id = '6a0e8f3b-1c2d-4e5f-9a7b-3c4d5e6f7a8b'`)).toEqual([{ seat_id: 'us-congress:CA-12', name: 'Rosa Delgado' }])
    expect(all(db, `PRAGMA foreign_key_check`)).toEqual([])
  })

  describe('members-elect', () => {
    // Whoever certainly or likely holds each seat on a day. Those who only may
    // hold it are left out, as on the pages.
    const holders = (db: DatabaseSync, day: string, where = '1', certainty = `r.certainty <> 'possible'`) =>
      all(db, `SELECT s.id AS seat, s.chamber, r.affiliation, r.certainty, d.name FROM roles r JOIN seats s ON s.id = r.seat_id JOIN deciders d ON d.id = r.decider_id
        WHERE s.body_id = 'us-congress' AND (r.starts_on IS NULL OR r.starts_on <= '${day}') AND (r.ends_on IS NULL OR '${day}' < r.ends_on) AND ${certainty} AND ${where}`)
    const tally = (rows: Record<string, any>[]) => rows.reduce<Record<string, number>>((n, r) => ((n[r.affiliation] = (n[r.affiliation] ?? 0) + 1), n), {})

    it('never puts two people in one seat, before or after the term starts', () => {
      const db = database()
      db.exec(seed)
      for (const day of ['2026-11-19', '2027-01-02', '2027-01-03', '2027-06-01']) {
        const seats = holders(db, day).map((r) => r.seat)
        expect(seats.length).toBe(new Set(seats).size)
      }
    })

    it('never has one person holding two seats at once', () => {
      const db = database()
      db.exec(seed)
      for (const day of ['2026-11-19', '2027-01-03']) {
        const names = holders(db, day).map((r) => r.name)
        expect(names.length).toBe(new Set(names).size)
      }
    })

    it('fills the Senate from the day the term starts, and the House but for the seats still undecided', () => {
      const db = database()
      db.exec(seed)
      expect(tally(holders(db, '2027-01-03', `s.chamber = 'Senate'`))).toEqual({ Democrat: 54, Independent: 2, Republican: 44 })
      const house = holders(db, '2027-01-03', `s.chamber = 'House' AND s.is_voting = 1`)
      // 435 less the two Louisiana seats that go to a runoff on December 12
      expect(house.length).toBe(433)
      // 258 called, and two more who lead in a recount
      expect(tally(house).Democrat).toBe(260)
      expect(house.filter((r) => r.certainty === 'likely').map((r) => r.name).sort()).toEqual(['Chuck Hubbard', 'Jake Johnson'])
    })

    it('leaves today as it is', () => {
      const db = database()
      db.exec(seed)
      expect(tally(holders(db, '2026-11-19', `s.chamber = 'Senate'`))).toEqual({ Democrat: 45, Independent: 2, Republican: 53 })
      expect(holders(db, '2026-11-19', `d.id LIKE 'elect-%'`)).toEqual([])
    })

    it('moves a sitting member to a new seat under the id they already have, with their record', () => {
      const db = database()
      db.exec(seed)
      const seatsOf = (day: string) => holders(db, day, `d.name = 'Chris Pappas'`).map((r) => r.seat)
      expect(seatsOf('2026-11-19')).toEqual(['us-congress:NH-1'])
      expect(seatsOf('2027-01-03')).toEqual(['us-congress:NH-sen-2'])
      expect(all(db, `SELECT COUNT(*) AS n FROM deciders WHERE name = 'Chris Pappas'`)[0].n).toBe(1)
    })

    it('gives a seat in a recount to whoever leads, as likely, with the holder as possible', () => {
      const db = database()
      db.exec(seed)
      const claims = (day: string) => holders(db, day, `s.id = 'us-congress:MN-1'`, '1').map((r) => [r.name, r.certainty]).sort()
      expect(claims('2026-11-19')).toEqual([['Brad Finstad', 'certain']])
      expect(claims('2027-01-03')).toEqual([
        ['Brad Finstad', 'possible'],
        ['Jake Johnson', 'likely'],
      ])
      expect(all(db, `SELECT DISTINCT contest FROM roles WHERE seat_id = 'us-congress:MN-1' AND starts_on IS NOT NULL`)).toEqual([{ contest: 'recount' }])
    })

    it('leaves a seat going to a runoff with nobody holding it, and both candidates possible', () => {
      const db = database()
      db.exec(seed)
      expect(holders(db, '2027-01-03', `s.id IN ('us-congress:LA-5', 'us-congress:LA-6')`)).toEqual([])
      expect(holders(db, '2027-01-03', `s.id = 'us-congress:LA-5'`, '1').map((r) => [r.name, r.certainty]).sort()).toEqual([
        ['Gabe Firment', 'possible'],
        ['Pat Moore', 'possible'],
      ])
    })

    it('marks the incoming committee chair as likely', () => {
      const db = database()
      db.exec(seed)
      expect(all(db, `SELECT d.name, h.certainty FROM office_holders h JOIN deciders d ON d.id = h.decider_id WHERE h.office_id = 'us-senate-finance-chair' ORDER BY h.starts_on IS NOT NULL`)).toEqual([
        { name: 'Mike Crapo', certainty: 'certain' },
        { name: 'Ron Wyden', certainty: 'likely' },
      ])
    })
  })
})

describe('0013_presumed_weight', () => {
  const db = database('0013')
  db.exec(`
    INSERT INTO bodies (id, slug, name) VALUES ('b', 'b', 'Body');
    INSERT INTO deciders (id, slug, name, sort_name) VALUES ('ann', 'ann', 'Ann', 'Ann');
    INSERT INTO questions (id, slug, body_id, kind, title, short_title) VALUES ('policy', 'policy', 'b', 'position', 'Policy?', 'Policy');
    INSERT INTO sources (id, url, created_at) VALUES ('s', 'https://news.example/a', '2026-01-01');
    INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES ('a', 'ann', 'does', '2026-01-01', 'Voted.', '2026-01-01');
    INSERT INTO readings (id, act_id, question_id, position, weight, created_at) VALUES ('r', 'a', 'policy', 'support', 'concrete', '2026-01-01');
    INSERT INTO proposals (id, source_id, origin, created_at) VALUES ('p', 's', 'model', '2026-01-01');
    INSERT INTO proposal_items (id, proposal_id, decider_id, question_id, act_id, kind, quote, reading, weight) VALUES
      ('read', 'p', 'ann', 'policy', 'x', 'says', 'Words.', 'support', 'passing'), ('lead', 'p', 'ann', 'policy', 'y', 'says', 'Excerpt.', NULL, NULL);
  `)
  db.exec(migration('0013_presumed_weight.sql'))

  it('keeps every weight as it was, a lead still having none', () => {
    expect(all(db, `SELECT weight FROM readings`)).toEqual([{ weight: 'concrete' }])
    expect(all(db, `SELECT id, weight FROM proposal_items ORDER BY id`)).toEqual([{ id: 'lead', weight: null }, { id: 'read', weight: 'passing' }])
  })

  it('takes a presumed weight, and still refuses one that is not a weight', () => {
    db.exec(`UPDATE readings SET weight = 'presumed'; UPDATE proposal_items SET weight = 'presumed' WHERE id = 'read'`)
    expect(() => db.exec(`UPDATE readings SET weight = 'heavy'`)).toThrow()
    expect(() => db.exec(`UPDATE proposal_items SET weight = 'heavy' WHERE id = 'read'`)).toThrow()
  })
})

describe('0017_source_published_from', () => {
  const db = database('0017')
  db.exec(`
    INSERT INTO bodies (id, slug, name) VALUES ('b', 'b', 'Body');
    INSERT INTO deciders (id, slug, name, sort_name) VALUES ('ann', 'ann', 'Ann', 'Ann');
    INSERT INTO sources (id, url, title, published_on, archive_url, created_at) VALUES
      ('dated', 'https://news.example/dated', 'Dated by hand', '2018-07-19', 'https://web.archive.org/web/1/https://news.example/dated', '2026-01-01'),
      ('undated', 'https://news.example/undated', 'No date', NULL, NULL, '2026-01-02');
    INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES ('a', 'ann', 'says', '2018-07-19', 'Words.', '2026-01-01');
    INSERT INTO reports (id, source_id, act_id, created_at) VALUES ('r', 'dated', 'a', '2026-01-01');
    INSERT INTO proposals (id, source_id, origin, created_at) VALUES ('p', 'undated', 'model', '2026-01-02');
  `)
  db.exec(migration('0017_source_published_from.sql'))

  it('marks a date already on a source as an editor’s, and leaves an undated source with no origin', () => {
    expect(all(db, `SELECT id, published_on, published_on_from, archive_url FROM sources ORDER BY id`)).toEqual([
      { id: 'dated', published_on: '2018-07-19', published_on_from: 'editor', archive_url: 'https://web.archive.org/web/1/https://news.example/dated' },
      { id: 'undated', published_on: null, published_on_from: null, archive_url: null },
    ])
    expect([count(db, 'reports'), count(db, 'proposals')]).toEqual([1, 1])
  })

  it('takes the three origins and refuses anything else', () => {
    db.exec(`UPDATE sources SET published_on_from = 'page' WHERE id = 'undated'`)
    db.exec(`UPDATE sources SET published_on_from = 'search' WHERE id = 'undated'`)
    expect(() => db.exec(`UPDATE sources SET published_on_from = 'model' WHERE id = 'undated'`)).toThrow()
  })
})

describe('0018_reads_point_at_sources', () => {
  const db = database('0018')
  db.exec(`
    INSERT INTO bodies (id, slug, name) VALUES ('b', 'b', 'Body');
    INSERT INTO questions (id, slug, body_id, kind, title, short_title) VALUES ('q1', 'q1', 'b', 'position', 'One?', 'One'), ('q2', 'q2', 'b', 'position', 'Two?', 'Two');
    INSERT INTO sources (id, url, title, published_on, published_on_from, created_at) VALUES ('on-file', 'https://news.example/on-file', 'On file', '2018-07-19', 'page', '2026-01-01');
    INSERT INTO article_reads (url, question_id, read_at, outcome, model, detail) VALUES
      ('https://news.example/on-file', 'q1', '2026-11-01T00:00:00Z', 'queued', 'm', NULL),
      ('https://news.example/nothing', 'q1', '2026-11-02T00:00:00Z', 'no_acts', 'm', 'Nothing.'),
      ('https://news.example/nothing', 'q2', '2026-11-03T00:00:00Z', 'no_acts', 'm', NULL);
  `)
  db.exec(migration('0018_reads_point_at_sources.sql'))

  it('gives an article read with nothing found a source of its own, dated by its first read', () => {
    expect(all(db, `SELECT url, title, created_at FROM sources WHERE id <> 'on-file'`)).toEqual([{ url: 'https://news.example/nothing', title: null, created_at: '2026-11-02T00:00:00Z' }])
    expect(all(db, `SELECT title, published_on FROM sources WHERE id = 'on-file'`)).toEqual([{ title: 'On file', published_on: '2018-07-19' }])
  })

  it('keeps every read, pointed at its source', () => {
    expect(all(db, `SELECT s.url, r.question_id, r.outcome, r.detail FROM article_reads r JOIN sources s ON s.id = r.source_id ORDER BY r.read_at`)).toEqual([
      { url: 'https://news.example/on-file', question_id: 'q1', outcome: 'queued', detail: null },
      { url: 'https://news.example/nothing', question_id: 'q1', outcome: 'no_acts', detail: 'Nothing.' },
      { url: 'https://news.example/nothing', question_id: 'q2', outcome: 'no_acts', detail: null },
    ])
    expect(all(db, `PRAGMA foreign_key_check`)).toEqual([])
  })
})

describe('0019_signed_in_contributors', () => {
  const db = database('0019')
  db.exec(`
    INSERT INTO auth_users (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('u', '', 'u@reader.test', 1, '2026-11-01', '2026-11-01');
    INSERT INTO people (id, display_name, muted_at, created_at) VALUES ('u', 'Una', '2026-11-02', '2026-11-01');
    INSERT INTO comments (id, thread_id, author_name, person_id, body, created_at) VALUES
      ('signed-in', 'hot:ann', 'Una', 'u', 'Signed in.', '2026-11-03'),
      ('signed-out', 'hot:ann', 'Visitor', NULL, 'Signed out.', '2026-11-04');
  `)
  db.exec(migration('0019_signed_in_contributors.sql'))

  it('keeps the comments of signed-in people and deletes the ones posted signed out', () => {
    expect(all(db, `SELECT * FROM comments`)).toEqual([{ id: 'signed-in', thread_id: 'hot:ann', person_id: 'u', body: 'Signed in.', created_at: '2026-11-03' }])
  })

  it('refuses a comment with no person, or with a person who does not exist', () => {
    expect(() => db.exec(`INSERT INTO comments (id, thread_id, person_id, body, created_at) VALUES ('none', 'hot:ann', NULL, 'x', '2026-11-05')`)).toThrow()
    expect(() => db.exec(`INSERT INTO comments (id, thread_id, person_id, body, created_at) VALUES ('nobody', 'hot:ann', 'no-such-person', 'x', '2026-11-05')`)).toThrow()
  })

  it('keeps each person and their name, without the muting', () => {
    expect(all(db, `SELECT * FROM people`)).toEqual([{ id: 'u', display_name: 'Una', created_at: '2026-11-01' }])
  })
})

describe('0021_reviews', () => {
  const db = database('0021')
  db.exec(`
    INSERT INTO bodies (id, slug, name) VALUES ('b', 'b', 'Body');
    INSERT INTO deciders (id, slug, name, sort_name) VALUES ('ann', 'ann', 'Ann', 'Ann');
    INSERT INTO questions (id, slug, body_id, parent_id, kind, title, short_title, implies_on_parent) VALUES
      ('policy', 'policy', 'b', NULL, 'position', 'Policy?', 'Policy', NULL),
      ('bill', 'bill', 'b', 'policy', 'formal_act', 'Signed the bill?', 'Bill', 'support');
    INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES ('signed', 'ann', 'commits', '2026-01-01', 'Cosponsored.', '2026-01-02');
    INSERT INTO readings (id, act_id, question_id, position, weight, via_question_id, created_at) VALUES
      ('on-bill', 'signed', 'bill', 'support', 'concrete', NULL, '2026-01-02'),
      ('implied', 'signed', 'policy', 'support', 'concrete', 'bill', '2026-01-02');
    INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES ('hinted', 'ann', 'says', '2026-02-01', 'Not so sure.', '2026-02-02');
    INSERT INTO readings (id, act_id, question_id, position, weight, via_question_id, created_at) VALUES ('leaning', 'hinted', 'policy', 'lean_oppose', 'clear', NULL, '2026-02-02');
  `)
  db.exec(migration('0021_reviews.sql'))

  it('keeps each reading read directly as a review by the editors', () => {
    expect(all(db, `SELECT id, reviewer_id, act_id, question_id, position, weight, based_on, updated_at FROM reviews WHERE act_id = 'signed'`)).toEqual([
      { id: 'on-bill', reviewer_id: EDITORS_ID, act_id: 'signed', question_id: 'bill', position: 'support', weight: 'concrete', based_on: null, updated_at: '2026-01-02' },
    ])
    expect(all(db, `PRAGMA foreign_key_check`)).toEqual([])
  })

  it('keeps a lean against left from before 0012 as a passing reading against, which a review can say', () => {
    expect(all(db, `SELECT position, weight FROM reviews WHERE id = 'leaning'`)).toEqual([{ position: 'oppose', weight: 'passing' }])
  })

  it('adds the editors as a person, with an account at an address that cannot receive mail', () => {
    expect(all(db, `SELECT p.display_name, u.email FROM people p JOIN auth_users u ON u.id = p.id WHERE p.id = '${EDITORS_ID}'`)).toEqual([
      { display_name: 'Editors', email: expect.stringMatching(/\.invalid$/) },
    ])
  })

  it('marks an act as the same as one other act, never as itself, and only by a person on file', () => {
    const mark = (act: string, sameAs: string, by: string = EDITORS_ID) => db.exec(`INSERT INTO same_acts (act_id, same_as_id, marked_by, marked_at) VALUES ('${act}', '${sameAs}', '${by}', 't')`)
    mark('hinted', 'signed')
    expect(() => mark('hinted', 'signed')).toThrow()
    expect(() => mark('signed', 'signed')).toThrow()
    expect(() => mark('signed', 'hinted', 'nobody')).toThrow()
    db.exec(`DELETE FROM same_acts`)
  })

  it('refuses a second review by one reviewer of one act on one question, and a reviewer who does not exist', () => {
    expect(() => db.exec(`INSERT INTO reviews (id, reviewer_id, act_id, question_id, position, weight, created_at, updated_at) VALUES ('again', '${EDITORS_ID}', 'signed', 'bill', 'oppose', 'clear', 't', 't')`)).toThrow()
    expect(() => db.exec(`INSERT INTO reviews (id, reviewer_id, act_id, question_id, position, weight, created_at, updated_at) VALUES ('stranger', 'nobody', 'signed', 'policy', 'oppose', 'clear', 't', 't')`)).toThrow()
  })
})

describe('0022_reviews_come_in', () => {
  const db = database('0022')
  db.exec(`
    INSERT INTO bodies (id, slug, name) VALUES ('b', 'b', 'Body');
    INSERT INTO deciders (id, slug, name, sort_name) VALUES ('ann', 'ann', 'Ann', 'Ann');
    INSERT INTO questions (id, slug, body_id, kind, title, short_title) VALUES ('policy', 'policy', 'b', 'position', 'Policy?', 'Policy');
    INSERT INTO sources (id, url, created_at) VALUES ('waiting-src', 'https://news.example/waiting', 't'), ('done-src', 'https://news.example/done', 't'), ('empty-src', 'https://news.example/empty', 't');
    INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES ('published', 'ann', 'says', '2026-01-01', 'I am for it.', 't');
    INSERT INTO reviews (id, reviewer_id, act_id, question_id, position, weight, created_at, updated_at) VALUES ('rv', '${EDITORS_ID}', 'published', 'policy', 'support', 'clear', 't', 't');
    INSERT INTO proposals (id, source_id, origin, status, created_at) VALUES ('waiting', 'waiting-src', 'model', 'pending', 't'), ('done', 'done-src', 'model', 'reviewed', 't');
    INSERT INTO proposal_items (id, proposal_id, decider_id, question_id, act_id, kind, quote, reading, weight, status) VALUES
      ('w1', 'waiting', 'ann', 'policy', 'not-yet', 'says', 'Maybe.', 'support', 'clear', 'pending'),
      ('kept', 'done', 'ann', 'policy', 'published', 'says', 'I am for it.', 'support', 'clear', 'accepted'),
      ('turned-down', 'done', 'ann', 'policy', 'never', 'says', 'Not really.', 'oppose', 'clear', 'rejected');
    INSERT INTO proposal_notes (id, proposal_id, proposal_item_id, kind, body, created_at) VALUES
      ('n-waiting', 'waiting', 'w1', 'submitter', 'Why.', 't'), ('n-turned-down', 'done', 'turned-down', 'review', 'Not in the article.', 't');
    INSERT INTO proposal_contexts (id, proposal_id, proposal_item_id, before, after) VALUES ('c-waiting', 'waiting', 'w1', 'b', 'a'), ('c-turned-down', 'done', 'turned-down', 'b', 'a'), ('c-kept', 'done', 'kept', 'b', 'a');
    INSERT INTO proposal_mentions (id, proposal_id, decider_id, words) VALUES ('m-waiting', 'waiting', 'ann', 'Named.');
    INSERT INTO article_reads (source_id, question_id, read_at, outcome) VALUES ('waiting-src', 'policy', 't', 'queued'), ('empty-src', 'policy', 't', 'no_acts');
  `)
  apply(db, '0022_reviews_come_in.sql')

  it('drops waiting proposals and what hangs off them, and lets the news search read their articles again', () => {
    expect(all(db, `SELECT id FROM proposals`)).toEqual([{ id: 'done' }])
    expect([count(db, 'proposal_mentions'), all(db, `SELECT id FROM proposal_contexts`), all(db, `SELECT source_id FROM article_reads`)]).toEqual([0, [{ id: 'c-kept' }], [{ source_id: 'empty-src' }]])
    expect(all(db, `PRAGMA foreign_key_check`)).toEqual([])
  })

  it("keeps a reviewed proposal's link to each act it published, and its editors' notes without a link to a dropped item", () => {
    expect(all(db, `SELECT id, proposal_id, decider_id, question_id, act_id, excerpt FROM proposal_items`)).toEqual([{ id: 'kept', proposal_id: 'done', decider_id: 'ann', question_id: 'policy', act_id: 'published', excerpt: null }])
    expect(all(db, `SELECT id, proposal_item_id FROM proposal_notes`)).toEqual([{ id: 'n-turned-down', proposal_item_id: null }])
  })

  it("names the news reader as the sender of the model's proposals, and as an agent", () => {
    expect(all(db, `SELECT submitted_by FROM proposals`)).toEqual([{ submitted_by: NEWS_READER_ID }])
    expect(all(db, `SELECT kind, display_name FROM people WHERE id = '${NEWS_READER_ID}'`)).toEqual([{ kind: 'agent', display_name: 'News reader' }])
  })

  it('keeps every act and review, and takes an act with no date and a review that says nothing', () => {
    expect([count(db, 'acts'), count(db, 'reviews')]).toEqual([1, 1])
    db.exec(`INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES ('undated', 'ann', 'says', NULL, 'Some day.', 't')`)
    db.exec(`INSERT INTO reviews (id, reviewer_id, act_id, question_id, position, weight, created_at, updated_at) VALUES ('nothing', '${EDITORS_ID}', 'undated', 'policy', NULL, NULL, 't', 't')`)
    expect(all(db, `SELECT position, weight FROM reviews WHERE id = 'rv'`)).toEqual([{ position: 'support', weight: 'clear' }])
    expect(() => db.exec(`INSERT INTO reviews (id, reviewer_id, act_id, question_id, position, weight, created_at, updated_at) VALUES ('odd', '${NEWS_READER_ID}', 'undated', 'policy', 'maybe', NULL, 't', 't')`)).toThrow()
    expect(all(db, `PRAGMA foreign_key_check`)).toEqual([])
  })
})
