import { MCEvent } from '@managed-components/types'
import amplitude from '.'

// Minimal fakes to drive the component's registered event listeners and
// capture the request body it would POST to Amplitude.
const listeners: Record<string, (event: MCEvent) => any> = {}

const fakeManager: any = {
  addEventListener: (type: string, cb: (event: MCEvent) => any) => {
    listeners[type] = cb
  },
  fetch: (() => undefined) as any, // replaced per-test below
}

describe('Amplitude MC time mapping', () => {
  it('maps payload.time_ms to the reserved top-level time field and keeps it in event_properties', async () => {
    const fetchMock = vi.fn()
    fakeManager.fetch = fetchMock

    const clientStore: Record<string, string> = {}
    const client: any = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      language: 'en',
      ip: '203.0.113.5',
      url: new URL('https://example.com/'),
      get: (k: string) => clientStore[k],
      set: (k: string, v: string) => {
        clientStore[k] = v
        return true
      },
    }

    // Boot the component so it registers its listeners.
    await amplitude(fakeManager, { api_key: 'test-key' })

    const timeMs = 1718000000000
    const event: any = {
      type: 'event',
      client,
      payload: {
        event_type: 'wager_placed',
        time_ms: timeMs,
      },
    }

    listeners['event'](event as MCEvent)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const sentEvent = body.events[0]

    // The fix: reserved top-level `time` is populated from time_ms.
    expect(sentEvent.time).toBe(timeMs)
    // Intentional duplication: time_ms is NOT deleted, so the catch-all loop
    // still copies it into event_properties (same pattern as revenue/insert_id).
    expect(sentEvent.event_properties.time_ms).toBe(timeMs)
  })
})
