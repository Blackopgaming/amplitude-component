import { describe, expect, it, vi } from 'vitest'
import component from './index'

type Listener = (event: any) => Promise<void> | void

const createMocks = () => {
  const listeners: Record<string, Listener> = {}
  const fetch = vi.fn()
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
