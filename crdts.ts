import assert from 'assert'
import consoleLib from 'console'
import chalk from 'chalk'

globalThis.console = new consoleLib.Console({
  stdout: process.stdout, stderr: process.stderr,
  inspectOptions: {depth: null}
})

// atEnd flag for sync9.
export type Id = [agent: string, seq: number]
export type Version = Record<string, number> // Last seen seq for each agent.

export type Algorithm = {
  localInsert: <T>(this: Algorithm, doc: Doc<T>, agent: string, pos: number, content: T) => void
  integrate: <T>(doc: Doc<T>, newItem: Item<T>, idx_hint?: number) => void
  printDoc: <T>(doc: Doc<T>) => void
  ignoreTests?: string[]
}

// These aren't used, but they should be. They show how the items actually work for each algorithm.
type YjsItem<T> = {
  content: T,
  id: Id,

  // Left and right implicit in document list.
  // null represents document's root / end.
  originLeft: Id | null,
  originRight: Id | null,

  isDeleted: boolean,
}

type AMItem<T> = {
  content: T,
  id: Id,

  originLeft: Id | null,
  seq: number, // Must be larger than all prev sequence numbers on the peer that created this.

  isDeleted: boolean,
}

type Sync9Item<T> = {
  // Sync9 items are splittable spans - which is weird in this
  // library because items only contain 1 entry. So the entry is
  // nullable, thus having length 0 or 1.
  content: T | null,

  id: Id,

  originLeft: Id | null,
  insertAfter: boolean, // identifies whether we insert at the start / end of originLeft.

  isDeleted: boolean,
}

export type Item<T> = {
  // Sync9 items must be splittable spans - which is weird in this
  // library because items only contain 1 entry. So the entry is
  // nullable, thus having length 0 or 1.
  content: T | null,

  // For sync9 the seq must advance by 2 each time, so we have insert positions both before and after this item.
  id: Id,

  originLeft: Id | null,
  originRight: Id | null,
  seq: number,
  insertAfter: boolean, // Only for sync9.

  isDeleted: boolean,
}



export interface Doc<T = string> {
  content: Item<T>[] // Could take Item as a type parameter, but eh. This is better for demos.

  version: Version // agent => last seen seq.
  length: number // Number of items not deleted

  maxSeq: number // Only for AM.
}

export const newDoc = <T>(): Doc<T> => ({
  content: [],
  version: {},
  length: 0,
  maxSeq: 0,
})

// **** Common code and helpers

// We never actually compare the third argument in sync9.
const idEq2 = (a: Id | null, agent: string, seq: number): boolean => (
  a != null && (a[0] === agent && a[1] === seq)
)
const idEq = (a: Id | null, b: Id | null): boolean => (
  a == b || (a != null && b != null && a[0] === b[0] && a[1] === b[1])
)

let hits = 0
let misses = 0

// idx_hint is a small optimization so when we know the general area of
// an item, we search nearby instead of just scanning the whole document.
const findItem2 = <T>(doc: Doc<T>, needle: Id | null, atEnd: boolean = false, idx_hint: number = -1): number => {
  if (needle == null) return -1
  else {
    const [agent, seq] = needle
    // This little optimization *halves* the time to run the editing trace benchmarks.
    if (idx_hint >= 0 && idx_hint < doc.content.length) {
      const hint_item = doc.content[idx_hint]
      if ((!atEnd && idEq2(hint_item.id, agent, seq))
          || (hint_item.content != null && atEnd && idEq2(hint_item.id, agent, seq))) {
        hits++
        return idx_hint
      }
      // Try nearby.
      // const RANGE = 10
      // for (let i = idx_hint < RANGE ? 0 : idx_hint - RANGE; i < doc.content.length && i < idx_hint + RANGE; i++) {
      //   const item = doc.content[i]
      //   if ((!atEnd && idEq2(item.id, agent, seq))
      //       || (item.content != null && atEnd && idEq2(item.id, agent, seq))) {
      //     hits++
      //     return i
      //   }
      // }
    }

    misses++
    const idx = doc.content.findIndex(({content, id}) => (
      (!atEnd && idEq2(id, agent, seq)) || (content != null && atEnd && idEq2(id, agent, seq)))
    )
      // : doc.content.findIndex(({id}) => idEq(id, needle))
    if (idx < 0) throw Error('Could not find item') // Could use a ternary if not for this!
    return idx
  }
}

const findItem = <T>(doc: Doc<T>, needle: Id | null, idx_hint: number = -1): number => (
  findItem2(doc, needle, false, idx_hint)
)

// const getNextSeq = <T>(doc: Doc<T>, agent: string): number => {
//   const last = doc.version[agent]
//   return last == null ? 0 : last + 1
// }

const findItemAtPos = <T>(doc: Doc<T>, pos: number, stick_end: boolean = false): number => {
  let i = 0
  // console.log('pos', pos, doc.length, doc.content.length)
  for (; i < doc.content.length; i++) {
    const item = doc.content[i]
    if (stick_end && pos === 0) return i
    else if (item.isDeleted || item.content == null) continue
    else if (pos === 0) return i

    pos--
  }

  if (pos === 0) return i
  else throw Error('past end of the document')
}

// const nextSeq = (agent: string): number =>

function localInsert<T>(this: Algorithm, doc: Doc<T>, agent: string, pos: number, content: T) {
  let i = findItemAtPos(doc, pos)
  this.integrate(doc, {
    content,
    id: [agent, (doc.version[agent] ?? -1) + 1],
    isDeleted: false,
    originLeft: doc.content[i - 1]?.id ?? null,
    originRight: doc.content[i]?.id ?? null, // Only for yjs
    insertAfter: true, // Unused by yjs and AM.
    seq: doc.maxSeq + 1, // Only for AM.
  }, i)
}

function localInsertSync9<T>(this: Algorithm, doc: Doc<T>, agent: string, pos: number, content: T) {
  let i = findItemAtPos(doc, pos, true)
  // For sync9 our insertion point is different based on whether or not our parent has children.
  let parentIdBase = doc.content[i - 1]?.id ?? null
  let originLeft: Id | null = parentIdBase == null ? null : [parentIdBase[0], parentIdBase[1]]
  let insertAfter = true

  for (;; i++) {
    // Scan until we find something with no children to insert after.
    let nextItem = doc.content[i]
    if (nextItem == null || !idEq(nextItem.originLeft, parentIdBase)) break

    parentIdBase = nextItem.id
    originLeft = [nextItem.id[0], nextItem.id[1]]
    insertAfter = false
    // If the current item has content, we need to slice it and insert before its content.
    if (nextItem.content != null) break
  }

  // console.log('parentId', parentId)

  this.integrate(doc, {
    content,
    id: [agent, (doc.version[agent] ?? -1) + 1],
    isDeleted: false,
    originLeft,
    insertAfter,

    originRight: null, // Only for yjs
    seq: 0, // Only for AM.
  }, i)
}

export const localDelete = <T>(doc: Doc<T>, agent: string, pos: number): void => {
  // This is very incomplete.
  const item = doc.content[findItemAtPos(doc, pos)]
  if (!item.isDeleted) {
    item.isDeleted = true
    doc.length -= 1
  }
}

export const getArray = <T>(doc: Doc<T>): T[] => (
  doc.content.filter(i => !i.isDeleted && i.content != null).map(i => i.content!)
)

const printdoc = <T>(doc: Doc<T>, showSeq: boolean, showOR: boolean, showIsAfter: boolean) => {
  const depth: Record<string, number> = {}
  // const kForId = (id: Id, c: T | null) => `${id[0]} ${id[1]} ${id[2] ?? c != null}`
  const kForItem = (id: Id, isAfter: boolean) => `${id[0]} ${id[1]} ${isAfter}`
  for (const i of doc.content) {
    const d = i.originLeft == null ? 0 : depth[kForItem(i.originLeft, i.insertAfter)] + 1
    depth[kForItem(i.id, i.content != null)] = d

    let content = `${i.content == null
      ? '.'
      : i.isDeleted ? chalk.strikethrough(i.content) : chalk.yellow(i.content)
    } at [${i.id}] (parent [${i.originLeft}])`
    if (showSeq) content += ` seq ${i.seq}`
    if (showOR) content += ` originRight [${i.originRight}]`
    if (showIsAfter) content += ` ${i.insertAfter ? 'after' : chalk.blue('before')}`
    // console.log(`${'| '.repeat(d)}${i.content == null ? chalk.strikethrough(content) : content}`)
    console.log(`${'| '.repeat(d)}${i.content == null ? chalk.grey(content) : content}`)
  }
}

export const isInVersion = (id: Id | null, version: Version) => {
  if (id == null) return true
  const seq = version[id[0]]
  return seq != null && seq >= id[1]
}

export const canInsertNow = <T>(op: Item<T>, doc: Doc<T>): boolean => (
  // We need op.id to not be in doc.versions, but originLeft and originRight to be in.
  // We're also inserting each item from each agent in sequence.
  !isInVersion(op.id, doc.version)
    && (op.id[1] === 0 || isInVersion([op.id[0], op.id[1] - 1], doc.version))
    && isInVersion(op.originLeft, doc.version)
    && isInVersion(op.originRight, doc.version)
)

// Merge all missing items from src into dest.
// NOTE: This currently does not support moving deletes!
export const mergeInto = <T>(algorithm: Algorithm, dest: Doc<T>, src: Doc<T>) => {
  // The list of operations we need to integrate
  const missing: (Item<T> | null)[] = src.content.filter(op => op.content != null && !isInVersion(op.id, dest.version))
  let remaining = missing.length

  while (remaining > 0) {
    // Find the next item in remaining and insert it.
    let mergedOnThisPass = 0

    for (let i = 0; i < missing.length; i++) {
      const op = missing[i]
      if (op == null || !canInsertNow(op, dest)) continue
      algorithm.integrate(dest, op)
      missing[i] = null
      remaining--
      mergedOnThisPass++
    }

    assert(mergedOnThisPass)
  }
}


// *** Per algorithm integration functions. Note each CRDT will only use
// one of these integration methods depending on the desired semantics.

// This is a slight modification of yjs with a few tweaks to make some
// of the CRDT puzzles resolve better.
const integrateYjsMod = <T>(doc: Doc<T>, newItem: Item<T>, idx_hint: number = -1) => {
  const lastSeen = doc.version[newItem.id[0]] ?? -1
  if (newItem.id[1] !== lastSeen + 1) throw Error('Operations out of order')
  doc.version[newItem.id[0]] = newItem.id[1]

  let left = findItem(doc, newItem.originLeft, idx_hint - 1)
  let destIdx = left + 1
  let right = newItem.originRight == null ? doc.content.length : findItem(doc, newItem.originRight, idx_hint)
  let scanning = false

  for (let i = destIdx; ; i++) {
    // Inserting at the end of the document. Just insert.
    if (!scanning) destIdx = i
    if (i === doc.content.length) break
    if (i === right) break // No ambiguity / concurrency. Insert here.

    let other = doc.content[i]

    let oleft = findItem(doc, other.originLeft, idx_hint - 1)
    let oright = other.originRight == null ? doc.content.length : findItem(doc, other.originRight, idx_hint)

    // The logic below summarizes to:
    // if (oleft < left || (oleft === left && oright === right && newItem.id[0] < o.id[0])) break
    // if (oleft === left) scanning = oright < right

    // Ok now we implement the punnet square of behaviour
    if (oleft < left) {
      // Top row. Insert, insert, arbitrary (insert)
      break
    } else if (oleft === left) {
      // Middle row.
      if (oright < right) {
        // This is tricky. We're looking at an item we *might* insert after - but we can't tell yet!
        scanning = true
        continue
      } else if (oright === right) {
        // Raw conflict. Order based on user agents.
        if (newItem.id[0] < other.id[0]) break
        else {
          scanning = false
          continue
        }
      } else { // oright > right
        scanning = false
        continue
      }
    } else { // oleft > left
      // Bottom row. Arbitrary (skip), skip, skip
      continue
    }
  }

  // We've found the position. Insert here.
  doc.content.splice(destIdx, 0, newItem)
  if (!newItem.isDeleted) doc.length += 1
}

const integrateYjs = <T>(doc: Doc<T>, newItem: Item<T>, idx_hint: number = -1) => {
  const lastSeen = doc.version[newItem.id[0]] ?? -1
  if (newItem.id[1] !== lastSeen + 1) throw Error('Operations out of order')
  doc.version[newItem.id[0]] = newItem.id[1]

  let left = findItem(doc, newItem.originLeft, idx_hint - 1)
  let destIdx = left + 1
  let right = newItem.originRight == null ? doc.content.length : findItem(doc, newItem.originRight, idx_hint)
  let scanning = false

  for (let i = destIdx; ; i++) {
    // Inserting at the end of the document. Just insert.
    if (!scanning) destIdx = i
    if (i === doc.content.length) break
    if (i === right) break // No ambiguity / concurrency. Insert here.

    let other = doc.content[i]

    let oleft = findItem(doc, other.originLeft, idx_hint - 1)
    let oright = other.originRight == null ? doc.content.length : findItem(doc, other.originRight, idx_hint)

    // The logic below can be summarized in these two lines:
    // if (oleft < left || (oleft === left && oright === right && newItem.id[0] <= o.id[0])) break
    // if (oleft === left) scanning = newItem.id[0] <= o.id[0]

    // Ok now we implement the punnet square of behaviour
    if (oleft < left) {
      // Top row. Insert, insert, arbitrary (insert)
      break
    } else if (oleft === left) {
      // Middle row.
      if (newItem.id[0] > other.id[0]) {
        scanning = false
        continue
      } else if (oright === right) {
        break
      } else {
        scanning = true
        continue
      }
    } else {
      // Bottom row. Arbitrary (skip), skip, skip
      continue
    }
  }

  // We've found the position. Insert here.
  doc.content.splice(destIdx, 0, newItem)
  if (!newItem.isDeleted) doc.length += 1
}

const integrateAutomerge = <T>(doc: Doc<T>, newItem: Item<T>, idx_hint: number = -1) => {
  const {id} = newItem
  assert(newItem.seq >= 0)

  const lastSeen = doc.version[id[0]] ?? -1
  if (id[1] !== lastSeen + 1) throw Error('Operations out of order')
  doc.version[id[0]] = id[1]

  let parent = findItem(doc, newItem.originLeft, idx_hint - 1)
  let destIdx = parent + 1

  // Scan for the insert location. Stop if we reach the end of the document
  for (; destIdx < doc.content.length; destIdx++) {
    let o = doc.content[destIdx]

    // This is an unnecessary optimization (I couldn't help myself). It
    // doubles the speed when running the local editing traces by
    // avoiding calls to findItem() below. When newItem.seq > o.seq
    // we're guaranteed to end up falling into a branch that calls
    // break;.
    if (newItem.seq > o.seq) break

    // Optimization: This call halves the speed of this automerge
    // implementation. Its only needed to see if o.originLeft has been
    // visited in this loop, which we could calculate much more
    // efficiently.
    let oparent = findItem(doc, o.originLeft, idx_hint - 1)

    // All the logic below can be expressed in this single line:
    // if (oparent < parent || (oparent === parent && (newItem.seq === o.seq) && id[0] < o.id[0])) break

    // Ok now we implement the punnet square of behaviour
    if (oparent < parent) {
      // We've gotten to the end of the list of children. Stop here.
      break
    } else if (oparent === parent) {
      // Concurrent items from different useragents are sorted first by seq then agent.

      // NOTE: For consistency with the other algorithms, adjacent items
      // are sorted in *ascending* order of useragent rather than
      // *descending* order as in the actual automerge. It doesn't
      // matter for correctness, but its something to keep in mind if
      // compatibility matters. The reference checker inverts AM client
      // ids.

      // Inverted item sequence number comparisons are used in place of originRight for AM.
      if (newItem.seq > o.seq) {
        break
      } else if (newItem.seq === o.seq) {
        if (id[0] < o.id[0]) break
        else continue
      } else {
        continue
      }
    } else {
      // Skip child
      continue
    }
  }

  if (newItem.seq > doc.maxSeq) doc.maxSeq = newItem.seq

  // We've found the position. Insert here.
  doc.content.splice(destIdx, 0, newItem)
  if (!newItem.isDeleted) doc.length += 1
}

// Same as integrateAutomerge above, but shorter.
const integrateAutomergeSmol = <T>(doc: Doc<T>, newItem: Item<T>, idx_hint: number = -1) => {
  const {id: [agent, seq]} = newItem
  const parent = findItem(doc, newItem.originLeft, idx_hint - 1)

  // Scan to find the insert location
  let i
  for (i = parent + 1; i < doc.content.length; i++) {
    let o = doc.content[i]
    if (newItem.seq > o.seq) break // Optimization to avoid findItem call along the hot path
    let oparent = findItem(doc, o.originLeft, idx_hint - 1)

    // Should we insert here?
    if (oparent < parent
      || (oparent === parent
        && (newItem.seq === o.seq)
        && agent < o.id[0])
    ) break
  }

  // We've found the position. Insert at position *i*.
  doc.content.splice(i, 0, newItem)
  doc.version[agent] = seq
  doc.maxSeq = Math.max(doc.maxSeq, newItem.seq)
  if (!newItem.isDeleted) doc.length += 1
}

const integrateSync9 = <T>(doc: Doc<T>, newItem: Item<T>, idx_hint: number = -1) => {
  const {id: [agent, seq]} = newItem
  const lastSeen = doc.version[agent] ?? -1
  if (seq !== lastSeen + 1) throw Error('Operations out of order')
  doc.version[agent] = seq

  let parentIdx = findItem2(doc, newItem.originLeft, newItem.insertAfter, idx_hint - 1)
  let destIdx = parentIdx + 1

  // if (parentIdx >= 0 && newItem.originLeft && (newItem.originLeft[1] === doc.content[parentIdx].id[1]) && doc.content[parentIdx].content != null) {
  if (parentIdx >= 0 && newItem.originLeft && !newItem.insertAfter && doc.content[parentIdx].content != null) {
    // Split left item to add null content item to the set
    doc.content.splice(parentIdx, 0, {
      ...doc.content[parentIdx],
      content: null
    })
    // We can skip the loop because we know we're an only child.

  } else {
    for (; destIdx < doc.content.length; destIdx++) {
      let other = doc.content[destIdx]
      // We still need to skip children of originLeft.
      let oparentIdx = findItem2(doc, other.originLeft, other.insertAfter, idx_hint - 1)

      if (oparentIdx < parentIdx) break
      else if (oparentIdx === parentIdx) {
        // if (!idEq(other.originLeft, newItem.originLeft)) break
        if (newItem.id[0] < other.id[0]) break
        else continue
      } else continue
    }
  }

  // We've found the position. Insert here.
  doc.content.splice(destIdx, 0, newItem)
  if (!newItem.isDeleted && newItem.content != null) doc.length += 1
}

type DoubleRga1Item<T> = {
  content: T;
  id: Id;

  // The parent in the originLeft tree.
  originLeftItem: DoubleRga1Item<T> | null;
  // The depth in the originLeft tree (0 for null, the implicit root).
  leftDepth: number;
  // The parent in the originRight tree *restricted to
  // our originLeft siblings*. This might be null even if
  // originRight is non-null, in case originRight is not
  // an originLeft sibling.
  originRightItem: DoubleRga1Item<T> | null;
  // The depth in the originRight tree (0 for null, the implicit root).
  rightDepth: number;

  isDeleted: boolean;

  // These are only used when this item is grabbed from an
  // existing doc and treated as if it
  // has been sent over the network, in mergeInto.
  // Otherwise the "item" versions are used.
  originLeft: Id | null;
  originRight: Id | null;

  // Unused, just here to make this compatible with Item<T>.
  seq: 0;
  insertAfter: false;
}

/**
 * Comparison function for DoubleRga1Item's.
 *
 * The order is a tree walk over the originLeftItem tree,
 * with each node before its children. To sort siblings in
 * that tree, the order is a tree walk over the originRightItem
 * tree, with each node after its children.
 *
 * @return A negative number if a < b, a positive number if
 * a > b, 0 if a === b.
 */
function compareDoubleRga1<T>(a: DoubleRga1Item<T>, b: DoubleRga1Item<T>): number {
  // Find left ancestors at their min leftDepth.
  let aAncL = a, bAncL = b;
  while (aAncL.leftDepth > bAncL.leftDepth) {
    aAncL = aAncL.originLeftItem!;
  }
  while (bAncL.leftDepth > aAncL.leftDepth) {
    bAncL = bAncL.originLeftItem!;
  }
  if (aAncL === bAncL) {
    // One is an ancestor of the other.
    // Whichever started deeper is farther right.
    return a.leftDepth - b.leftDepth;
  }
  // Walk up the originLeftItem tree until you find siblings.
  while (aAncL.originLeftItem !== bAncL.originLeftItem) {
    aAncL = aAncL.originLeftItem!;
    bAncL = bAncL.originLeftItem!;
  }
  // Compare the unequal (originLeftItem) siblings aAncL and bAncL.
  // Their order is given by the originRightItem
  // tree. So we need to repeat the comparison used for the
  // originLeftItem tree, but using the right* variables,
  // and starting at aAncL/bAncL instead of a/b.
  let aAncR = aAncL, bAncR = bAncL;
  // Find ancestors at their min rightDepth.
  while (aAncR.rightDepth > bAncR.rightDepth) {
    aAncR = aAncR.originRightItem!;
  }
  while (bAncR.rightDepth > aAncR.rightDepth) {
    bAncR = bAncR.originRightItem!;
  }
  if (aAncR === bAncR) {
    // One is an ancestor of the other.
    // Whichever started deeper is farther left.
    return bAncL.rightDepth - aAncL.rightDepth;
  }
  // Walk up the originRightItem tree until you find siblings.
  while (aAncR.originRightItem !== bAncR.originRightItem) {
    aAncR = aAncR.originRightItem!;
    bAncR = bAncR.originRightItem!;
  }
  // Compare the unequal (originRightItem) siblings aAncR and bAncR.
  // Their order is given by agent.
  return aAncR.id[0] > bAncR.id[0]? 1: -1;
}

const integrateDoubleRga1 = <T>(doc: Doc<T>, newItem: Item<T>, idx_hint: number = -1) => {
  const lastSeen = doc.version[newItem.id[0]] ?? -1
  if (newItem.id[1] !== lastSeen + 1) throw Error('Operations out of order')
  doc.version[newItem.id[0]] = newItem.id[1]

  let left = findItem(doc, newItem.originLeft, idx_hint - 1)
  let right = newItem.originRight == null ? doc.content.length : findItem(doc, newItem.originRight, idx_hint)

  const originLeftItem = <DoubleRga1Item<T> | null> (doc.content[left] ?? null);
  // Only set originRightItem if originRight is our sibling
  // in the originLeft tree.
  let originRightItem: DoubleRga1Item<T> | null = null;
  if (doc.content[right] !== undefined) {
    const asItem = <DoubleRga1Item<T>> doc.content[right];
    if (asItem.originLeftItem === originLeftItem) {
      originRightItem = asItem;
    }
  }

  const newStoredItem: DoubleRga1Item<T> = {
    content: newItem.content!,
    id: newItem.id,
    originLeftItem,
    leftDepth: (originLeftItem?.leftDepth ?? 0) + 1,
    originRightItem,
    rightDepth: (originRightItem?.rightDepth ?? 0) + 1,
    isDeleted: newItem.isDeleted,
    originLeft: newItem.originLeft,
    originRight: newItem.originRight,
    seq: 0,
    insertAfter: false
  };

  // Loop over the document until we find an item greater than
  // newStoredItem.
  let i = left + 1;
  for (; i < right; i++) {
    if (compareDoubleRga1(newStoredItem, <DoubleRga1Item<T>> doc.content[i]) < 0) break;
  }

  // We've found the position. Insert here.
  doc.content.splice(i, 0, newStoredItem)
  if (!newStoredItem.isDeleted) doc.length += 1
}

type DoubleRga2Item<T> = {
  content: T;
  id: Id;

  // The parent in the tree. Null if the parent is the root
  // (start of the list).
  parent: DoubleRga2Item<T> | null;
  parentIsLeft: boolean;
  // The depth in the tree (0 for null, the implicit root).
  depth: number;

  isDeleted: boolean;

  // These are only used when this item is grabbed from an
  // existing doc and treated as if it
  // has been sent over the network, in mergeInto.
  // Otherwise the "item" versions are used.
  originLeft: Id | null;
  originRight: Id | null;

  // Unused, just here to make this compatible with Item<T>.
  seq: 0;
  insertAfter: false;
}

/**
 * Comparison function for DoubleRga2Item's.
 *
 * The order is a tree walk, with order:
 * - a node's left children (children with parentIsLeft = false)
 * - the node
 * - the node's right children.
 * Siblings on the same sort are sorted by agent.
 *
 * @return A negative number if a < b, a positive number if
 * a > b, 0 if a === b.
 */
function compareDoubleRga2<T>(a: DoubleRga2Item<T>, b: DoubleRga2Item<T>): number {
  // Find ancestors at their min depth.
  let aAnc = a, bAnc = b;
  let lastMoveIsLeft = false;
  while (aAnc.depth > bAnc.depth) {
    lastMoveIsLeft = aAnc.parentIsLeft;
    aAnc = aAnc.parent!;
  }
  while (bAnc.depth > aAnc.depth) {
    lastMoveIsLeft = bAnc.parentIsLeft;
    bAnc = bAnc.parent!;
  }
  if (aAnc === bAnc) {
    // One is an ancestor of the other.
    // Whichever started shallower is in the direction of
    // the last move.
    return (a.depth - b.depth) * (lastMoveIsLeft? 1: -1);
  }
  // Walk up the tree until you find siblings.
  while (aAnc.parent !== bAnc.parent) {
    aAnc = aAnc.parent!;
    bAnc = bAnc.parent!;
  }
  // Compare the unequal siblings aAnc and bAnc.
  // Their order is given by: siblings with right parent
  // are less then siblings with left parent; siblings on
  // same side are sorted by agent.
  if (aAnc.parentIsLeft && !bAnc.parentIsLeft) return 1;
  else if (!aAnc.parentIsLeft && bAnc.parentIsLeft) return -1;
  else {
  return aAnc.id[0] > bAnc.id[0]? 1: -1;
  }
}

const integrateDoubleRga2 = <T>(doc: Doc<T>, newItem: Item<T>, idx_hint: number = -1) => {
  const lastSeen = doc.version[newItem.id[0]] ?? -1
  if (newItem.id[1] !== lastSeen + 1) throw Error('Operations out of order')
  doc.version[newItem.id[0]] = newItem.id[1]

  let left = findItem(doc, newItem.originLeft, idx_hint - 1)
  let right = newItem.originRight == null ? doc.content.length : findItem(doc, newItem.originRight, idx_hint)

  const originLeftItem = <DoubleRga2Item<T> | undefined> doc.content[findItem(doc, newItem.originLeft, idx_hint - 1)];
  const originRightItem = <DoubleRga2Item<T> | undefined> doc.content[findItem(doc, newItem.originRight, idx_hint + 1)];

  let parent: DoubleRga2Item<T> | null;
  let parentIsLeft: boolean;
  // Use originLeft as our (left) parent, unless originRight
  // is already a descendant of originRight, in which case we
  // use that as our (right) parent.
  // (As an optimization, this choice should be made on the sender,
  // then the sender sends parent & parentIsLeft instead of
  // originLeft & originRight.)
  if (originRightItem !== undefined && idEq(originRightItem.originLeft, newItem.originLeft)) {
    // originRight is a descendant of originLeft.
    parentIsLeft = false;
    parent = originRightItem;
  } else {
    // Default case: use originLeft as the parent.
    parentIsLeft = true;
    parent = originLeftItem ?? null;
  }

  const newStoredItem: DoubleRga2Item<T> = {
    content: newItem.content!,
    id: newItem.id,
    parent,
    parentIsLeft,
    depth: (parent?.depth ?? 0) + 1,
    isDeleted: newItem.isDeleted,
    originLeft: newItem.originLeft,
    originRight: newItem.originRight,
    seq: 0,
    insertAfter: false
  };

  // Loop over the document until we find an item greater than
  // newStoredItem.
  let i = left + 1;
  for (; i < right; i++) {
    if (compareDoubleRga2(newStoredItem, <DoubleRga2Item<T>> doc.content[i]) < 0) break;
  }

  // We've found the position. Insert here.
  doc.content.splice(i, 0, newStoredItem)
  if (!newStoredItem.isDeleted) doc.length += 1
}

/**
 * Slight modification of integrateYjsMod to make it
 * equivalent to Double RGA.
 *
 * Specifically, we only use originRight if its originLeft
 * is the same as ours; else we pretend it is null. This is
 * because in Double RGA, we only use the originRight tree
 * to sort siblings within the originLeft tree.
 */
const integrateDoubleRgaEquiv = <T>(doc: Doc<T>, newItem: Item<T>, idx_hint: number = -1) => {
  const lastSeen = doc.version[newItem.id[0]] ?? -1
  if (newItem.id[1] !== lastSeen + 1) throw Error('Operations out of order')
  doc.version[newItem.id[0]] = newItem.id[1]

  let left = findItem(doc, newItem.originLeft, idx_hint - 1)
  let destIdx = left + 1
  let right = newItem.originRight == null ? doc.content.length : findItem(doc, newItem.originRight, idx_hint)
  // **DoubleRgaEquiv change**
  if (doc.content[right] !== undefined &&
      !idEq(doc.content[right].originLeft, newItem.originLeft)) {
    // Pretend newItem.originRight is null.
    right = doc.content.length;
  }
  let scanning = false

  for (let i = destIdx; ; i++) {
    // Inserting at the end of the document. Just insert.
    if (!scanning) destIdx = i
    if (i === doc.content.length) break
    if (i === right) break // No ambiguity / concurrency. Insert here.

    let other = doc.content[i]

    let oleft = findItem(doc, other.originLeft, idx_hint - 1)
    let oright = other.originRight == null ? doc.content.length : findItem(doc, other.originRight, idx_hint)
    // **DoubleRgaEquiv change**
    if (doc.content[oright] !== undefined &&
        !idEq(doc.content[oright].originLeft, other.originLeft)) {
      // Pretend other.originRight is null.
      // As an optimization, we could instead make this
      // change once when integrating other.
      oright = doc.content.length;
    }

    // The logic below summarizes to:
    // if (oleft < left || (oleft === left && oright === right && newItem.id[0] < o.id[0])) break
    // if (oleft === left) scanning = oright < right

    // Ok now we implement the punnet square of behaviour
    if (oleft < left) {
      // Top row. Insert, insert, arbitrary (insert)
      break
    } else if (oleft === left) {
      // Middle row.
      if (oright < right) {
        // This is tricky. We're looking at an item we *might* insert after - but we can't tell yet!
        scanning = true
        continue
      } else if (oright === right) {
        // Raw conflict. Order based on user agents.
        if (newItem.id[0] < other.id[0]) break
        else {
          scanning = false
          continue
        }
      } else { // oright > right
        scanning = false
        continue
      }
    } else { // oleft > left
      // Bottom row. Arbitrary (skip), skip, skip
      continue
    }
  }

  // We've found the position. Insert here.
  doc.content.splice(destIdx, 0, newItem)
  if (!newItem.isDeleted) doc.length += 1
}

export const sync9: Algorithm = {
  localInsert: localInsertSync9,
  integrate: integrateSync9,
  printDoc(doc) { printdoc(doc, false, false, true) },
}

export const yjsMod: Algorithm = {
  localInsert,
  integrate: integrateYjsMod,
  printDoc(doc) { printdoc(doc, false, true, false) },
}

export const yjs: Algorithm = {
  localInsert,
  integrate: integrateYjs,
  printDoc(doc) { printdoc(doc, false, true, false) },

  ignoreTests: ['withTails2']
}

export const automerge: Algorithm = {
  localInsert,
  // The two integrate methods are equivalent.
  // integrate: integrateAutomerge,
  integrate: integrateAutomergeSmol,
  printDoc(doc) { printdoc(doc, true, false, false) },

  // Automerge doesn't handle these cases as I would expect.
  ignoreTests: [
    'interleavingBackward',
    'interleavingBackward2',
    'withTails',
    'withTails2'
  ]
}

export const doubleRgaEquiv: Algorithm = {
  localInsert,
  integrate: integrateDoubleRgaEquiv,
  printDoc(doc) { printdoc(doc, false, true, false) },
}

export const doubleRga1: Algorithm = {
  localInsert,
  integrate: integrateDoubleRga1,
  printDoc(doc) { printdoc(doc, false, true, false) },
}

export const doubleRga2: Algorithm = {
  localInsert,
  integrate: integrateDoubleRga2,
  printDoc(doc) { printdoc(doc, false, true, false) },
}

export const printDebugStats = () => {
  console.log('hits', hits, 'misses', misses)
}


// ;(() => {
//   // console.clear()

//   const alg = yjs

//   let doc1 = newDoc()

//   alg.localInsert(doc1, 'a', 0, 'x')
//   alg.localInsert(doc1, 'a', 1, 'y')
//   alg.localInsert(doc1, 'a', 0, 'z') // zxy

//   // alg.printDoc(doc1)

//   let doc2 = newDoc()

//   alg.localInsert(doc2, 'b', 0, 'a')
//   alg.localInsert(doc2, 'b', 1, 'b')
//   // alg.localInsert(doc2, 'b', 2, 'c')

//   mergeInto(alg, doc1, doc2)

//   alg.printDoc(doc1)

//   // console.log('\n\n\n')
// })()
