import { createTransaction, type Collection } from '@tanstack/db'
import { db, persist } from './db.ts'
import type { Write } from './review-plan.ts'

// One transaction, so everything a plan publishes reaches every reader together
// or not at all.
export function commit(writes: Write[]): Promise<unknown> {
  const tx = createTransaction({ mutationFn: persist })
  tx.mutate(() => {
    for (const w of writes) {
      const collection = db[w.on] as unknown as Collection<Record<string, unknown>, string>
      if (w.type === 'insert') collection.insert(w.row)
      else if (w.type === 'update') collection.update(w.id, (draft) => void Object.assign(draft, w.changes))
      else collection.delete(w.id)
    }
  })
  return tx.isPersisted.promise
}
