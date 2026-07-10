import { describe, expect, it, vi } from 'vitest'
import component from './index'

type Listener = (event: any) => Promise<void> | void

const createMocks = () => {
  const listeners: Record<string, Listener> = {}
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
  const manager = {
    addEventListener: (type: string, listener: Listener) => {
      listeners[type] = listener
    },
    fetch,
  }
  return { manager, listeners, fetch }
}

const createEvent = (payload: Record<string, any>, type = 'event') => {
  const kv: Record<string, string> = {}
  return {
    type,
    name: payload.event_type,
    payload,
    client: {
      url: 'https://example.com/',
      userAgent: 'Mozilla/5.0',
      language: 'en',
      ip: '127.0.0.1',
      get: (key: string) => kv[key],
      set: vi.fn((key: string, value: string) => {
        kv[key] = value
      }),
    },
  }
}

const setup = async () => {
  const { manager, listeners, fetch } = createMocks()
  await component(manager as any, { api_key: 'test-key' })
  return { listeners, fetch }
}

describe('required property gate (environment + brand)', () => {
  it('drops pageview events missing environment and brand', async () => {
    const { listeners, fetch } = await setup()
    const event = createEvent({}, 'pageview')
    await listeners.pageview(event)
    expect(fetch).not.toHaveBeenCalled()
    expect(event.client.set).not.toHaveBeenCalled()
  })

  it('drops events with only environment', async () => {
    const { listeners, fetch } = await setup()
    await listeners.event(createEvent({ environment: 'production' }))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('drops events with only brand', async () => {
    const { listeners, fetch } = await setup()
    await listeners.event(createEvent({ brand: 'acme' }))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('drops events with empty-string environment or brand', async () => {
    const { listeners, fetch } = await setup()
    await listeners.event(createEvent({ environment: '', brand: 'acme' }))
    await listeners.event(createEvent({ environment: 'production', brand: '' }))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends events with both environment and brand, forwarding them as event properties', async () => {
    const { listeners, fetch } = await setup()
    await listeners.event(
      createEvent({
        event_type: 'signup',
        environment: 'production',
        brand: 'acme',
      })
    )
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.events[0].event_type).toBe('signup')
    expect(body.events[0].event_properties.environment).toBe('production')
    expect(body.events[0].event_properties.brand).toBe('acme')
  })

  it('maps payload.time_ms to the reserved top-level time field', async () => {
    const { listeners, fetch } = await setup()
    const timeMs = 1718000000000
    await listeners.event(
      createEvent({
        event_type: 'wager_placed',
        environment: 'production',
        brand: 'acme',
        time_ms: timeMs,
      })
    )
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.events[0].time).toBe(timeMs)
    // time_ms is intentionally not deleted, so it also lands in event_properties
    expect(body.events[0].event_properties.time_ms).toBe(timeMs)
  })

  it('sends pageview events with both properties present', async () => {
    const { listeners, fetch } = await setup()
    await listeners.pageview(
      createEvent({ environment: 'production', brand: 'acme' }, 'pageview')
    )
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.events[0].event_type).toBe('pageview')
  })

  it('drops ecommerce events missing the properties', async () => {
    const { listeners, fetch } = await setup()
    await listeners.ecommerce(
      createEvent(
        {
          event_type: 'Order Completed',
          products: [{ product_id: 'p1', quantity: '1' }],
        },
        'ecommerce'
      )
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('accepts ecommerce events with environment and brand nested under payload.ecommerce', async () => {
    const { listeners, fetch } = await setup()
    await listeners.ecommerce(
      createEvent(
        {
          event_type: 'Order Completed',
          ecommerce: {
            environment: 'production',
            brand: 'acme',
            products: [{ product_id: 'p1', quantity: '2' }],
            total: 10,
          },
        },
        'ecommerce'
      )
    )
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.events[0].event_properties.environment).toBe('production')
    expect(body.events[0].event_properties.brand).toBe('acme')
  })

  it('omits device_id when the event has a user_id and no known device', async () => {
    const { listeners, fetch } = await setup()
    const event = createEvent({
      event_type: 'wager_placed',
      environment: 'production',
      brand: 'acme',
      user_id: 'user-123',
    })
    await listeners.event(event)
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.events[0].user_id).toBe('user-123')
    expect(body.events[0]).not.toHaveProperty('device_id')
    expect(event.client.set).not.toHaveBeenCalledWith(
      'device_id',
      expect.anything(),
      expect.anything()
    )
  })

  it('uses the device_id provided in the payload over everything else', async () => {
    const { listeners, fetch } = await setup()
    await listeners.event(
      createEvent({
        event_type: 'signup',
        environment: 'production',
        brand: 'acme',
        user_id: 'user-123',
        device_id: 'device-from-payload',
      })
    )
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.events[0].device_id).toBe('device-from-payload')
  })

  it('uses the device_id persisted in the client for frontend events', async () => {
    const { listeners, fetch } = await setup()
    const event = createEvent({
      event_type: 'signup',
      environment: 'production',
      brand: 'acme',
      user_id: 'user-123',
    })
    event.client.set('device_id', 'device-from-cookie')
    await listeners.event(event)
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.events[0].device_id).toBe('device-from-cookie')
  })

  it('generates and persists a device_id for anonymous events', async () => {
    const { listeners, fetch } = await setup()
    const event = createEvent(
      { environment: 'production', brand: 'acme' },
      'pageview'
    )
    await listeners.pageview(event)
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.events[0].device_id).toMatch(/[0-9a-f-]{36}/)
    expect(event.client.set).toHaveBeenCalledWith(
      'device_id',
      body.events[0].device_id,
      { scope: 'infinite' }
    )
  })

  it('accepts ecommerce events with environment and brand at the top level', async () => {
    const { listeners, fetch } = await setup()
    await listeners.ecommerce(
      createEvent(
        {
          event_type: 'Order Refunded',
          environment: 'staging',
          brand: 'acme',
          products: [{ product_id: 'p1', quantity: '1' }],
        },
        'ecommerce'
      )
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('delivery retry (LAKA-511)', () => {
  const okEvent = () =>
    createEvent({
      event_type: 'signup',
      environment: 'production',
      brand: 'acme',
    })

  it('retries a 5xx and succeeds on the second attempt', async () => {
    const { listeners, fetch } = await setup()
    fetch.mockResolvedValueOnce({ ok: false, status: 500 })
    await listeners.event(okEvent())
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retries a 429', async () => {
    const { listeners, fetch } = await setup()
    fetch.mockResolvedValueOnce({ ok: false, status: 429 })
    await listeners.event(okEvent())
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retries a network rejection', async () => {
    const { listeners, fetch } = await setup()
    fetch.mockRejectedValueOnce(new Error('connection reset'))
    await listeners.event(okEvent())
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('gives up after 3 attempts', async () => {
    const { listeners, fetch } = await setup()
    fetch.mockResolvedValue({ ok: false, status: 503 })
    await listeners.event(okEvent())
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('does not retry a permanent 4xx rejection', async () => {
    const { listeners, fetch } = await setup()
    fetch.mockResolvedValue({ ok: false, status: 400 })
    await listeners.event(okEvent())
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('sends the same body on each retry', async () => {
    const { listeners, fetch } = await setup()
    fetch.mockResolvedValueOnce({ ok: false, status: 500 })
    await listeners.event(okEvent())
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body)
  })
})

describe('event_id (LAKA-511 secondary)', () => {
  it('sends an incrementing numeric event_id', async () => {
    const { listeners, fetch } = await setup()
    const event = createEvent({
      event_type: 'signup',
      environment: 'production',
      brand: 'acme',
    })
    await listeners.event(event)
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.events[0].event_id).toBe(2)
  })
})
