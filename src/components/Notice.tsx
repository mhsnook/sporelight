import { definePrimitive } from '@ui-sdk/core'
import { createParts } from '@ui-sdk/react/primitive'

// A message on the page that an agent reads too. The bridge lists a primitive's
// title and description parts as its text, and leaves plain paragraphs out.
const notice = definePrimitive({
  name: 'notice',
  state: () => ({}),
  api: () => ({}),
  slots: (slot) => ({
    root: slot({ attrs: () => ({ role: 'status' }) }),
    title: slot({}),
    description: slot({}),
  }),
})

export const { Root: Notice, Title: NoticeTitle, Description: NoticeDescription } = createParts(notice, { root: 'div', title: 'p', description: 'p' })
