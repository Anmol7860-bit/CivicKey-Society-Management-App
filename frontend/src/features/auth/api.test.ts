import { refresh } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('refresh', () => {
  it('shares one request between concurrent callers, so a rotated token is never sent twice', async () => {
    const data = { accessToken: 'jwt', expiresIn: 900, user: { name: 'Riya' } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 })))

    const results = await Promise.all([refresh(), refresh(), refresh()])

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(results).toEqual([data, data, data])
  })

  it('sends a new request once the previous one has finished', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })))

    await refresh()
    await refresh()

    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
