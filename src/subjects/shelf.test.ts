import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '../db'
import { UNSORTED, bookSeed, latestBook, shelfBooks, splitShelf } from './shelf'

const s = (id: string, startedAt: number, min: number, subject?: string | null): SessionMeta => ({
  id,
  startedAt,
  task: `task ${id}`,
  goalMs: 0,
  elapsedMs: min * 60_000,
  hasClip: false,
  subject: subject === undefined ? undefined : { name: subject, for: `task ${id}`, by: 'you' },
})

describe('shelfBooks', () => {
  it('makes one book per subject, most time first, unsorted last', () => {
    const books = shelfBooks([
      s('a', 1, 30, 'Math'),
      s('b', 2, 90, 'Writing'),
      s('c', 3, 20, 'math'),
      s('d', 4, 200),
    ], ['Math', 'Writing'])
    expect(books.map((b) => b.name)).toEqual(['Writing', 'Math', null])
    expect(books[1].ms).toBe(50 * 60_000)
    expect(books[2].key).toBe(UNSORTED)
  })

  it('keeps each book newest first', () => {
    const [math] = shelfBooks([s('a', 1, 10, 'Math'), s('b', 5, 10, 'Math'), s('c', 3, 10, 'Math')])
    expect(math.sessions.map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })

  it('treats a deliberately cleared subject as unsorted', () => {
    expect(shelfBooks([s('a', 1, 10, null)])[0].key).toBe(UNSORTED)
  })
})

describe('latestBook', () => {
  it('opens the book with the newest session', () => {
    const books = shelfBooks([s('a', 9, 10, 'Spanish'), s('b', 2, 300, 'Writing')])
    expect(latestBook(books)).toBe(books.find((b) => b.name === 'Spanish')!.key)
  })

  it('is null on an empty shelf', () => {
    expect(latestBook([])).toBeNull()
  })
})

describe('bookSeed', () => {
  it('is steady for a key and differs between keys', () => {
    expect(bookSeed('math')).toBe(bookSeed('math'))
    expect(bookSeed('math')).not.toBe(bookSeed('writing'))
  })
})

describe('splitShelf', () => {
  it('gives every subject with an hour its own book, however small its share', () => {
    const books = shelfBooks([
      s('a', 1, 6000, 'Writing'),
      s('b', 2, 75, 'Physics EMF'), // about 1% of the time, still a book
      s('c', 3, 42, 'Leetcode'), // under an hour: the pile
      s('d', 4, 20), // unsorted, under an hour too
    ])
    const { standing, pile } = splitShelf(books)
    expect(standing.map((b) => b.name)).toEqual(['Writing', 'Physics EMF'])
    expect(pile.map((b) => b.name)).toEqual(['Leetcode', null])
  })

  it('stands everything up while nothing has an hour yet', () => {
    const { standing, pile } = splitShelf(shelfBooks([s('a', 1, 30, 'Math'), s('b', 2, 10, 'Art')]))
    expect(standing).toHaveLength(2)
    expect(pile).toHaveLength(0)
  })
})
