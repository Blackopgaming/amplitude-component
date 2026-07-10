import { ComponentSettings, Manager, MCEvent } from '@managed-components/types'
import UAParser from 'ua-parser-js'

// Get the user ID stored in the client, if it does not exist, then do not set it.
const getUserId = (event: MCEvent): string | null => {
  const userId = event.payload.user_id
  if (!userId) {
    return null
  }
  return userId
}

// Resolve the device ID: prefer an explicit payload value, then the ID
// persisted in the client (browser cookie). If neither exists and the event
// carries a user_id (typical for server-side calls, where there is no cookie
// jar to persist anything in), omit the device ID entirely so Amplitude
// derives a stable one by hashing the user_id. Only fabricate and persist a
// random UUID for anonymous events, where Amplitude requires at least one ID.
const getDeviceId = (
  event: MCEvent,
  payload: any,
  userId: string | null
): string | null => {
  const { client } = event
  const deviceId = payload.device_id || client.get('device_id')
  if (deviceId) {
    return deviceId
  }
  if (userId) {
    return null
  }
  const newDeviceId = crypto.randomUUID()
  client.set('device_id', newDeviceId, { scope: 'infinite' })
  return newDeviceId
}

// Get the session ID stored in the client, if it does not exist, make a new one, save it in the client, and return it.

const getSessionId = (event: MCEvent) => {
  const { client } = event
  let sessionId = client.get('session_id')
  if (!sessionId) {
    sessionId = new Date().getTime().toString()
    client.set('session_id', sessionId, { scope: 'session' })
  }
  return sessionId
}

// Get the Event ID stored in the client, add +1 to it, and set the new value in the client
const getEventId = (event: MCEvent) => {
  const { client } = event
  let eventId = parseInt(client.get('event_id') as string) || 1
  eventId++
  client.set('event_id', eventId.toString(), { scope: 'infinite' })
  return eventId
}

// Required properties every incoming call must carry. Calls missing either
// `environment` or `brand` are dropped before any processing or network I/O.
// Ecommerce calls may nest their properties under `payload.ecommerce`
// (mirroring the merge done in ecomDataMap), so check both levels.
const hasRequiredProperties = (event: MCEvent): boolean => {
  const payload = { ...event.payload, ...event.payload.ecommerce }
  const ok = Boolean(payload.environment) && Boolean(payload.brand)
  if (!ok) {
    console.debug(
      'amplitude: dropping event missing environment/brand:',
      payload.event_type
    )
  }
  return ok
}

export default async function (manager: Manager, settings: ComponentSettings) {
  const getEventData = (
    event: MCEvent,
    pageview: boolean,
    ecomPayload?: any
  ) => {
    const { client } = event
    const parsedUserAgent = UAParser(client.userAgent)
    const payload = ecomPayload ? ecomPayload : event.payload
    // eventData builds the eventData object to be used in the request body
    const userId = getUserId(event)
    const deviceId = getDeviceId(event, payload, userId)
    delete payload.eu_data

    const eventData = {
      event_type: pageview ? 'pageview' : payload.event_type,
      ...(userId && {
        user_id: userId,
      }),
      event_properties: { url: client.url },
      user_properties: {},
      groups: {},
      language: client.language,
      ip: client.ip,
      event_id: getEventId(event),
      session_id: getSessionId(event),
      os_name: parsedUserAgent.os.name,
      os_version: parsedUserAgent.os.version,
      device_manufacturer: parsedUserAgent.device.vendor,
      device_model: parsedUserAgent.device.model,
      ...(deviceId && { device_id: deviceId }),
      ...(payload.app_version && {
        app_version: payload.app_version,
      }),
      ...(payload.insert_id && {
        insert_id: payload.insert_id,
      }),
      ...(payload.time_ms && { time: payload.time_ms }),
      ...(payload.revenue && { revenue: payload.revenue }),
      ...(payload.revenueType && { revenueType: payload.revenueType }),
      ...(payload.productId && { productId: payload.productId }),
      ...(payload.quantity && { quantity: payload.quantity }),
    }

    for (const [key, value] of Object.entries(payload)) {
      if (key.startsWith('user_')) {
        eventData.user_properties[key.substring(5)] = value
      } else if (key.startsWith('groups_')) {
        eventData.groups[key.substring(7)] = value
      } else {
        eventData.event_properties[key] = value
      }
    }
    return eventData
  }

  // maps ecommerce data: ampliteude handles only transaction data (order completed/Refunded), the rest of the events will be just added to the event_properties object like any other event, but without the need for triggers)

  const ecomDataMap = (event: MCEvent) => {
    const { type, name } = event
    let { payload } = event
    payload = { ...payload, ...payload.ecommerce }
    delete payload.ecommerce
    if (type === 'ecommerce') {
      payload.event_type = name
      payload.productId = payload.products
        .map((product: any) => product.product_id)
        .join()
      payload.quantity ??= payload.products.reduce(
        (sum: any, product: any) => sum + parseInt(product.quantity, 10),
        0
      )
      payload.revenue = payload.revenue || payload.total || payload.value
      if (name === 'Order Completed') payload.revenueType = 'Purchase'
      else if (name === 'Order Refunded') payload.revenueType = 'Refund'
    }
    return payload
  }

  // Listeners await sendEvent so its retry loop runs inside the listener
  // dispatch the worker awaits (worker/src/handler.ts) — a dangling promise
  // would only be kept alive per-fetch by waitUntil, not between attempts.
  manager.addEventListener('pageview', async event => {
    if (!hasRequiredProperties(event)) return
    const isEUEndpoint = !!event.payload.eu_data
    const eventData = getEventData(event, true)
    await sendEvent(eventData, isEUEndpoint)
  })

  manager.addEventListener('event', async event => {
    if (!hasRequiredProperties(event)) return
    const isEUEndpoint = !!event.payload.eu_data
    const eventData = getEventData(event, false)
    await sendEvent(eventData, isEUEndpoint)
  })

  manager.addEventListener('ecommerce', async event => {
    if (!hasRequiredProperties(event)) return
    const isEUEndpoint = !!event.payload.eu_data
    const ecomPayload = ecomDataMap(event)
    const eventData = getEventData(event, false, ecomPayload)
    await sendEvent(eventData, isEUEndpoint)
  })

  // sendEvent function is the main functions to send a server side request
  const sendEvent = async (eventData: any, isEUEndpoint: boolean) => {
    const requestBody = {
      api_key: settings.api_key,
      ...(settings.min_id_length && {
        options: { min_id_length: settings.min_id_length },
      }), //if user configured a min_id_length in the options, include the options object
      events: [eventData],
    }

    const endpoint = isEUEndpoint
      ? 'https://api.eu.amplitude.com/2/httpapi'
      : 'https://api2.amplitude.com/2/httpapi'

    // LAKA-511: a fire-and-forget fetch silently drops the event on any
    // 429/5xx or network error. Await the response and retry transient
    // failures; only give up loudly.
    const MAX_ATTEMPTS = 3
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await manager.fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        })
        if (response?.ok) return
        if (response && response.status !== 429 && response.status < 500) {
          // Permanent rejection — retrying the identical payload cannot succeed.
          // Log the full event so a backfill can replay it (insert_id keeps
          // replays idempotent on the Amplitude side).
          console.error(
            `amplitude: event rejected (HTTP ${response.status}):`,
            JSON.stringify(eventData)
          )
          return
        }
        console.warn(
          `amplitude: attempt ${attempt}/${MAX_ATTEMPTS} got HTTP ${response?.status}`
        )
      } catch (err) {
        console.warn(
          `amplitude: attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
          err
        )
      }
      // ponytail: linear backoff; the whole loop blocks one Zaraz request, so keep it short
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, 250 * attempt))
      }
    }
    console.error(
      'amplitude: event lost after retries:',
      JSON.stringify(eventData)
    )
  }
}
