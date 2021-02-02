import * as cookieUtils from 'cookie'
import { bold } from 'chalk'
import { Headers, flattenHeadersObject } from 'headers-utils'
import { StrictEventEmitter } from 'strict-event-emitter'
import {
  RequestInterceptor,
  MockedResponse as MockedInterceptedResponse,
  Interceptor,
} from 'node-request-interceptor'
import { RequestHandlersList } from '../setupWorker/glossary'
import { MockedRequest } from '../utils/handlers/requestHandler'
import { getResponse } from '../utils/getResponse'
import { parseBody } from '../utils/request/parseBody'
import { isNodeProcess } from '../utils/internal/isNodeProcess'
import * as requestHandlerUtils from '../utils/handlers/requestHandlerUtils'
import { onUnhandledRequest } from '../utils/request/onUnhandledRequest'
import { ServerLifecycleEventsMap, SetupServerApi } from './glossary'
import { SharedOptions } from '../sharedOptions'
import { uuidv4 } from '../utils/internal/uuidv4'
import { request } from 'express'
import axios, { AxiosError } from 'axios'
import { rejects } from 'assert'

type PostRequestBody = {
  sampleRequests: {
    endpoint: string,
    restMethod: string,
    numberOfSamples: number
  }[]
}

const DEFAULT_LISTEN_OPTIONS: SharedOptions = {
  onUnhandledRequest: 'bypass',
}

/**
 * Creates a `setupServer` API using given request interceptors.
 * Useful to generate identical API using different patches to request issuing modules.
 */
export function createSetupServer(...interceptors: Interceptor[]) {

  const emitter = new StrictEventEmitter<ServerLifecycleEventsMap>()

  return function setupServer(
    ...requestHandlers: RequestHandlersList
  ): SetupServerApi {
    requestHandlers.forEach((handler) => {
      if (Array.isArray(handler))
        throw new Error(
          `[MSW] Failed to call "setupServer" given an Array of request handlers (setupServer([a, b])), expected to receive each handler individually: setupServer(a, b).`,
        )
    })
    const interceptor = new RequestInterceptor(interceptors)

    // Error when attempting to run this function in a browser environment.
    if (!isNodeProcess()) {
      throw new Error(
        '[MSW] Failed to execute `setupServer` in the environment that is not NodeJS (i.e. a browser). Consider using `setupWorker` instead.',
      )
    }

    // Store the list of request handlers for the current server instance,
    // so it could be modified at a runtime.
    let currentHandlers: RequestHandlersList = [...requestHandlers]

    interceptor.on('response', (req, res) => {
      const requestId = req.headers?.['x-msw-request-id'] as string

      if (res.headers['x-powered-by'] === 'msw') {
        emitter.emit('response:mocked', res, requestId)
      } else {
        emitter.emit('response:bypass', res, requestId)
      }
    })

    let requestHandlerInvocations: { [key: string]: number; } = {}
    currentHandlers.forEach((handler) => {
      requestHandlerInvocations[handler.getMetaInfo().header] = 0
    })

    return {
      async runtimes() {
        
        let numberOfSamples = 100;
        let postRequestBodies: { [key: string]: PostRequestBody } = {}
        
        currentHandlers.forEach((handler) => {
          let metaInfo = handler.getMetaInfo();

          // Skip non-rest handlers for now.
          if (metaInfo.type != 'rest') {
            console.warn(`Skipping runtime fetch for non-rest handler type: ${metaInfo.type}`);
            return;
          }

          // Skip RegExp masks for now.
          if (metaInfo.mask instanceof RegExp) {
            console.warn(`Skipping runtime fetch for RegExp endpoint: ${metaInfo.mask.toString()}`);
            return;
          }

          let firstSpaceIndex = metaInfo.header.indexOf(" ");
          let secondSpaceIndex = metaInfo.header.indexOf(" ", firstSpaceIndex + 1);

          if (firstSpaceIndex == -1 || secondSpaceIndex == -1) {
            console.warn(`Unrecognised meta header found in setupServer handler: ${metaInfo.header}`);
            return;
          }

          let restMethod = metaInfo.header.substring(firstSpaceIndex + 1, secondSpaceIndex);
          let endpoint = metaInfo.header.substring(secondSpaceIndex + 1);

          if (metaInfo.performanceModelEndpoint != undefined) {

            if (!postRequestBodies.hasOwnProperty(metaInfo.performanceModelEndpoint)) {
              postRequestBodies[metaInfo.performanceModelEndpoint] = {
                sampleRequests: []
              }
            }

            postRequestBodies[metaInfo.performanceModelEndpoint].sampleRequests.push({
              "restMethod": restMethod,
              "endpoint": endpoint,
              "numberOfSamples": numberOfSamples
            });
          }
        });

        // Send GET request with rest methods and endpoints to ProdModelService
        // Create promise that resolves by combining the runtimes? I want to be able to assert on multiples, so return dictionary of runtimes.
        let sampleRequestPromises = []
        for (const [key, value] of Object.entries(postRequestBodies)) {
          sampleRequestPromises.push(
            axios.post(`${key}/sample`, value, {
              // Hack for Jest jsdom + axios combination
              // https://github.com/axios/axios/issues/1180
              adapter: require('axios/lib/adapters/http'),
            })
              .then((response) => {
                // Contains the sample results of multiple models
                let sampleResultsMultipleModels = response.data

                // Relies on the convention of getMetaInfo().header for rest.ts
                // `[rest] ${method} ${mask.toString()}` for non-mask entries
                let aggregatedResponses = sampleResultsMultipleModels.map((modelSampleResult: any) => {
                  let header = `[rest] ${modelSampleResult["restMethod"]} ${modelSampleResult["endpoint"]}`
                  return {
                    "handlerHeader": header,
                    "invocationCount": requestHandlerInvocations[header],
                    "averageResponseTime": modelSampleResult["sampledResponseTimes"].reduce((a: number, b: number) => a + b, 0) / modelSampleResult["sampledResponseTimes"].length
                  }
                })
                
                return aggregatedResponses
              }, (error: AxiosError) => {
                console.error(`Sample request failed for model endpoint: ${key}`)
                console.error(error.message)
                return null;
              }))          
        }

        return Promise.all(sampleRequestPromises).then((sampleResponsesMultipleModelSvcs: any[]) => {
          return [].concat.apply([], sampleResponsesMultipleModelSvcs)
        })
      },
      listen(options) {

        const resolvedOptions = Object.assign(
          {},
          DEFAULT_LISTEN_OPTIONS,
          options,
        )

        interceptor.use(async (req) => {

          const requestId = uuidv4()

          const requestHeaders = new Headers(
            flattenHeadersObject(req.headers || {}),
          )

          if (req.headers) {
            req.headers['x-msw-request-id'] = requestId
          }

          const requestCookieString = requestHeaders.get('cookie')

          const mockedRequest: MockedRequest = {
            id: requestId,
            url: req.url,
            method: req.method,
            // Parse the request's body based on the "Content-Type" header.
            body: parseBody(req.body, requestHeaders),
            headers: requestHeaders,
            cookies: {},
            params: {},
            redirect: 'manual',
            referrer: '',
            keepalive: false,
            cache: 'default',
            mode: 'cors',
            referrerPolicy: 'no-referrer',
            integrity: '',
            destination: 'document',
            bodyUsed: false,
            credentials: 'same-origin',
          }

          emitter.emit('request:start', mockedRequest)

          if (requestCookieString) {
            // Set mocked request cookies from the `cookie` header of the original request.
            // No need to take `credentials` into account, because in NodeJS requests are intercepted
            // _after_ they happen. Request issuer should have already taken care of sending relevant cookies.
            // Unlike browser, where interception is on the worker level, _before_ the request happens.
            mockedRequest.cookies = cookieUtils.parse(requestCookieString)
          }

          if (mockedRequest.headers.get('x-msw-bypass')) {
            emitter.emit('request:end', mockedRequest)
            return
          }

          const { response, handler } = await getResponse(
            mockedRequest,
            currentHandlers,
          )

          if (!handler) {
            emitter.emit('request:unhandled', mockedRequest)
          }

          if (!response) {
            emitter.emit('request:end', mockedRequest)

            onUnhandledRequest(
              mockedRequest,
              resolvedOptions.onUnhandledRequest,
            )
            return
          }

          emitter.emit('request:match', mockedRequest)

          // Match registered, we track invocation count.
          if (handler != undefined) {
            let handlerHeader = handler.getMetaInfo().header
            if (requestHandlerInvocations.hasOwnProperty(handlerHeader)) {
              requestHandlerInvocations[handler.getMetaInfo().header] += 1
            } else {
              console.warn("Handler found whose invocation is not being tracked!" + handlerHeader);
            }
          }

          return new Promise<MockedInterceptedResponse>((resolve) => {
            const mockedResponse = {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers.getAllHeaders(),
              body: response.body as string,
            }

            // the node build will use the timers module to ensure @sinon/fake-timers or jest fake timers
            // don't affect this timeout.
            setTimeout(() => {
              resolve(mockedResponse)
            }, response.delay ?? 0)

            emitter.emit('request:end', mockedRequest)
          })
        })
      },

      use(...handlers) {
        requestHandlerUtils.use(currentHandlers, ...handlers)
      },

      restoreHandlers() {
        requestHandlerUtils.restoreHandlers(currentHandlers)
      },

      resetHandlers(...nextHandlers) {
        currentHandlers = requestHandlerUtils.resetHandlers(
          requestHandlers,
          ...nextHandlers,
        )
      },

      printHandlers() {
        currentHandlers.forEach((handler) => {
          const meta = handler.getMetaInfo()

          console.log(`\
${bold(meta.header)}
  Declaration: ${meta.callFrame}
`)
        })
      },

      on(eventType, listener) {
        emitter.addListener(eventType, listener)
      },

      close() {
        emitter.removeAllListeners()
        interceptor.restore()
      },
    }
  }
}
