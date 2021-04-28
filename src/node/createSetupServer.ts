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
import { MockedRequest, RequestHandlerMetaInfo } from '../utils/handlers/requestHandler'
import { getResponse } from '../utils/getResponse'
import { parseBody } from '../utils/request/parseBody'
import { isNodeProcess } from '../utils/internal/isNodeProcess'
import * as requestHandlerUtils from '../utils/handlers/requestHandlerUtils'
import { onUnhandledRequest } from '../utils/request/onUnhandledRequest'
import { ServerLifecycleEventsMap, SetupServerApi } from './glossary'
import { SharedOptions } from '../sharedOptions'
import { uuidv4 } from '../utils/internal/uuidv4'
import axios, { AxiosError } from 'axios'

export type EndpointPerformanceReport = {
  aggregatedResponses: AggregatedResponse[],
  invocationTimings: RequestHandlerInvocationTimings[]
}

export type AggregatedResponse = {
  handlerHeader: string,
  invocationCount: number,
  averageResponseTime: number
}

export type RequestHandlerInvocationTimings = {
  handlerHeader: string,
  startTime: number,
  endTime: number
}

type PostResponseBody = {
  endpoint: string,
  restMethod: string,
  sampledResponseTimes: number[]
}

type PostRequestBody = {
  sampleRequests: {
    endpoint: string,
    restMethod: string,
    numberOfSamples: number
  }[]
}

interface VirtualTimeline {
  start(): void
  stop(): void
  reset(): void
  getEvents(): VirtualTimelineEvent[]
  getDuration(): number
  handleIssueEvent(handlerHeader: string, predictedTime: number): string
  handleAwaitEvent(requestIdentifier: string): void
}

type ModelServiceSampleResult = {
  header: string,
  sampledResponseTimes: number[]
}

type ModelServiceResponse = ModelServiceSampleResult[]

const DEFAULT_LISTEN_OPTIONS: SharedOptions = {
  onUnhandledRequest: 'bypass',
}

export type VirtualTimelineEvent = {
  handlerHeader: string,
  // Time it was issued
  startTimeMs: number,
  // Time it got awaited. Can be undefined if results never relied on.
  awaitTimeMs: number | undefined
  // Predicted time + issue time.
  endTimeMs: number
}

export interface ServiceClientApi {
  issueHttpRequest(link: string): TrackedRestRequest
}

interface Stopwatch {
  start(): void
  stop(): void
  read(): number
  reset(): void
}

interface TrackedRestRequest {
  /**
   * Attaches callbacks for the resolution and/or rejection of the Promise.
   * @param onfulfilled The callback to execute when the Promise is resolved.
   * @param onrejected The callback to execute when the Promise is rejected.
   * @returns A Promise for the completion of which ever callback is executed.
   */
   unwrap<TResult1 = Response, TResult2 = never>(
    onfulfilled?: ((value: Response) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): Promise<TResult1 | TResult2>,
}

function initVirtualTimeline(): VirtualTimeline {

  let lastEventVirtualTimeMs: number = 0
  let virtualTimelineEvents: { [key: string]: VirtualTimelineEvent } = {}
  let stopwatch: Stopwatch = initStopwatch()

  return {
    start() {
      stopwatch.start()
    },
    stop() {
      stopwatch.stop()
    },
    reset() {
      lastEventVirtualTimeMs = 0
      stopwatch = initStopwatch()
      virtualTimelineEvents = {}
    },
    // We return a deep copy of the events to prevent inner state change by user
    getEvents() {
      return Object.values(virtualTimelineEvents).map((event: VirtualTimelineEvent) => {
        return Object.assign({}, event)
      })
    },
    getDuration() {
      return lastEventVirtualTimeMs + stopwatch.read()
    },
    handleAwaitEvent(
      requestIdentifier: string,
    ) {
      stopwatch.stop()

      console.log(`Real time elapsed: ${lastEventVirtualTimeMs + stopwatch.read()}`)
      console.log(`Predicted time elapsed: ${virtualTimelineEvents[requestIdentifier].endTimeMs}`)

      let awaitTimeMs = Math.max(
        lastEventVirtualTimeMs + stopwatch.read(),
        virtualTimelineEvents[requestIdentifier].endTimeMs)
      virtualTimelineEvents[requestIdentifier].awaitTimeMs = awaitTimeMs
      lastEventVirtualTimeMs = awaitTimeMs                

      stopwatch.reset()
      stopwatch.start()
    },
    handleIssueEvent(
      handlerHeader:string,
      predictedTime: number
    ) {
      stopwatch.stop()

      // Issue UUID for this http request
      let requestIdentifier = uuidv4()
      let issueTimeMs = lastEventVirtualTimeMs + stopwatch.read()
      virtualTimelineEvents[requestIdentifier] = {
        handlerHeader: handlerHeader,
        startTimeMs: issueTimeMs,
        endTimeMs: issueTimeMs + predictedTime,
        awaitTimeMs: undefined
      }
      lastEventVirtualTimeMs = issueTimeMs

      stopwatch.reset()
      stopwatch.start()

      return requestIdentifier
    }
  }
}

function trackedRestRequest(
  promise: Promise<Response>,
  requestIdentifier: string,
  virtualTimeline: VirtualTimeline
): TrackedRestRequest {

  let internalPromise: Promise<Response> = promise

  return {
    unwrap(
      onfulfilled?,
      onrejected?,
    ) {
      // Must be in the same then callback, so as to avoid preemption.
      // let x = Promise.resolve().then(() => console.log("1")).then(() => console.log("3"))
      // let y = Promise.resolve().then(() => console.log("2"))
      return internalPromise
        .then((response: Response) => {

          virtualTimeline.handleAwaitEvent(requestIdentifier)

          if (onfulfilled != undefined || onfulfilled != null) {
            return onfulfilled(response)
          } else {
            return response
          }

        }, (reason: any) => {

          virtualTimeline.handleAwaitEvent(requestIdentifier)

          if (onrejected != undefined || onrejected != null) {
            return onrejected(reason)
          } else {
            return reason
          }

        })
    }
  }
}

function trackedServiceClient(
  resolverDelaySecondsIndexedByHeader: { [key: string]: number },
  virtualTimeline: VirtualTimeline
): ServiceClientApi {

  return {
    issueHttpRequest(
      link: string
    ): TrackedRestRequest {

      // TODO: Hardcoded header format here. Is there a way to pass this in?
      let handlerHeader = `[rest] GET ${link}`
      if (!resolverDelaySecondsIndexedByHeader.hasOwnProperty(handlerHeader)) {
        throw new Error(`Predicted time taken missing for the header: ${handlerHeader}`)
      }

      let requestIdentifier = virtualTimeline.handleIssueEvent(
        handlerHeader,
        resolverDelaySecondsIndexedByHeader[handlerHeader] * 1000)

      return trackedRestRequest(
        axios.get(link),
        requestIdentifier,
        virtualTimeline
      )
    }  
  }   
}

function initStopwatch(): Stopwatch {
  let lastStart: number = 0
  let elapsedTime: number = 0
  let isRunning = false

  return {
    start() {
      if (isRunning) {
        return
      }

      lastStart = Date.now()
      isRunning = true
    },
    stop() {
      if (!isRunning) {
        return
      }

      elapsedTime += Date.now() - lastStart
      isRunning = false
    },
    read() {
      if (isRunning) {
        return elapsedTime + Date.now() - lastStart
      } else {
        return elapsedTime
      }
    },
    reset() {
      elapsedTime = 0
      lastStart = 0
      isRunning = false
    }
  }
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

    let requestHandlerInvocationTimings: RequestHandlerInvocationTimings[] = [];
    let requestHandlerInvocationCount: { [key: string]: number; } = {}
    let metaInfoIndexedByHeader: { [key: string]: RequestHandlerMetaInfo } = {}
    currentHandlers.forEach((handler) => {
      requestHandlerInvocationCount[handler.getMetaInfo().header] = 0
      metaInfoIndexedByHeader[handler.getMetaInfo().header] = handler.getMetaInfo()
    })
    let runtimeSamples: ModelServiceSampleResult[] | undefined = undefined
    let resolverDelaySecondsIndexedByHeader: { [key: string]: number } = {}

    // For virtual timeline construction
    let virtualTimeline: VirtualTimeline = initVirtualTimeline()

    return {
      getVirtualTimelineEvents() {
        return virtualTimeline.getEvents()
      },
      startVirtualTimeline() {
        virtualTimeline.reset()
        virtualTimeline.start()
      },
      stopVirtualTimeline() {
        virtualTimeline.stop()
      },
      getVirtualTimelineDuration() {
        return virtualTimeline.getDuration()
      },
      getTrackedServiceClient() {
        return trackedServiceClient(resolverDelaySecondsIndexedByHeader, virtualTimeline)
      },
      // Use this method if we need to sample the performance model before the test
      // in order to place the correct delays.
      async registerModelSampleDelays() {
        if (runtimeSamples == undefined) {
          runtimeSamples = await getRuntimeSamplesForModels(currentHandlers)
        }

        runtimeSamples.forEach((modelSampleResult: ModelServiceSampleResult) => {
          // Relies on the convention of getMetaInfo().header for rest.ts
          // `[rest] ${method} ${mask.toString()}` for non-mask entries
          let header = modelSampleResult.header
          let averageResponseTime = modelSampleResult["sampledResponseTimes"].reduce((a: number, b: number) => a + b, 0) / modelSampleResult["sampledResponseTimes"].length
          if (!metaInfoIndexedByHeader.hasOwnProperty(header)) {
            console.error("Something went wrong here! Header not recognised!")
          } else {
  
            let modelParameters = metaInfoIndexedByHeader[header].modelParameters
            if (modelParameters != undefined) {
              averageResponseTime = averageResponseTime * (modelParameters.scale  ?? 1)
            }
  
          }

          resolverDelaySecondsIndexedByHeader[header] = averageResponseTime
        })

      },
      async runtimes() {
        if (runtimeSamples == undefined) {
          runtimeSamples = await getRuntimeSamplesForModels(currentHandlers)
        }
        let aggregatedResponses = runtimeSamples.map((modelSampleResult: ModelServiceSampleResult) => {
          // Relies on the convention of getMetaInfo().header for rest.ts
          // `[rest] ${method} ${mask.toString()}` for non-mask entries
          let header = modelSampleResult.header
  
          let averageResponseTime = modelSampleResult["sampledResponseTimes"].reduce((a: number, b: number) => a + b, 0) / modelSampleResult["sampledResponseTimes"].length
  
          if (!metaInfoIndexedByHeader.hasOwnProperty(header)) {
            console.error("Something went wrong here! Header not recognised!")
          } else {
  
            let modelParameters = metaInfoIndexedByHeader[header].modelParameters
            if (modelParameters != undefined) {
              averageResponseTime = averageResponseTime * (modelParameters.scale  ?? 1)
            }
  
          }
  
          return {
            "handlerHeader": header,
            "invocationCount": requestHandlerInvocationCount[header],
            "averageResponseTime": averageResponseTime
          }
        })

        return {
          aggregatedResponses: aggregatedResponses,
          invocationTimings: requestHandlerInvocationTimings
        }
      },
      listen(options) {

        const resolvedOptions = Object.assign(
          {},
          DEFAULT_LISTEN_OPTIONS,
          options,
        )

        interceptor.use(async (req) => {

          const invocationStartTime = Date.now()

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
            if (requestHandlerInvocationCount.hasOwnProperty(handlerHeader)) {
              requestHandlerInvocationCount[handlerHeader] += 1
            } else {
              console.warn("Handler found whose invocation is not being tracked!" + handlerHeader);
            }

            requestHandlerInvocationTimings.push({
              handlerHeader: handlerHeader,
              startTime: invocationStartTime,
              endTime: resolverDelaySecondsIndexedByHeader[handlerHeader] * 1000 + invocationStartTime
            });
          }

          return new Promise<MockedInterceptedResponse>((resolve) => {
            const mockedResponse = {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers.getAllHeaders(),
              body: response.body as string,
            }

            // If mocked using performance model, impose delay!
            // if (handler != undefined) {
            //   let header = handler.getMetaInfo().header
            //   response.delay = resolverDelaySecondsIndexedByHeader[header] * 1000 ?? response.delay
            //   console.log(`Imposing a delay of ${response.delay} ms for header: ${header}`)
            // }

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

function getRuntimeSamplesForModels(
  handlers: RequestHandlersList
): Promise<ModelServiceSampleResult[]> {

  let numberOfSamples = 100;
  let postRequestBodies: { [key: string]: PostRequestBody } = {}
  
  // Here we iterate all registered handles in order to collate
  // requests that will be made to each modelservice endpoint.
  // An aggregate POST request body to each endpoint is then created.
  handlers.forEach((handler) => {
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

    if (metaInfo.modelParameters != undefined) {
      
      // Add to aggregated POST request for respective ModelService.
      let modelEndpoint = metaInfo.modelParameters.endpoint

      if (!postRequestBodies.hasOwnProperty(modelEndpoint)) {
        postRequestBodies[modelEndpoint] = {
          sampleRequests: []
        }
      }

      postRequestBodies[modelEndpoint].sampleRequests.push({
        "restMethod": restMethod,
        "endpoint": endpoint,
        "numberOfSamples": numberOfSamples
      });
    }
  });

  // Send POST request with rest methods and endpoints to ProdModelService
  // Create promise that resolves by combining the runtimes? I want to be able to assert on multiples, so return dictionary of runtimes.
  let sampleRequestPromises = []
  for (const [modelServiceEndpoint, postRequestBody] of Object.entries(postRequestBodies)) {

    let modelServicePromise = axios.post(`${modelServiceEndpoint}/sample`, postRequestBody, {
      // Hack for Jest jsdom + axios combination
      // https://github.com/axios/axios/issues/1180
      adapter: require('axios/lib/adapters/http'),
    }).then((response) => {

      // Post-processing after recieving responses from each ModelService endpoint.

      // Contains the sample results of multiple models
      let responseJson: PostResponseBody[] = response.data
      let modelServiceSampleResults: ModelServiceSampleResult[] = responseJson.map((sampleResponse: PostResponseBody) => {
        return {
          // Relies on the convention of getMetaInfo().header for rest.ts
          // `[rest] ${method} ${mask.toString()}` for non-mask entries
          header: `[rest] ${sampleResponse["restMethod"]} ${sampleResponse["endpoint"]}`,
          sampledResponseTimes: sampleResponse.sampledResponseTimes
        }
      })

      return modelServiceSampleResults      
      
    }, (error: AxiosError) => {
      throw new Error(`Sample request failed for model endpoint: ${modelServiceEndpoint}. Error message: ${error.message}`)
    })

    sampleRequestPromises.push(modelServicePromise)          
  }
  return Promise.all(sampleRequestPromises).then((sampleResponsesMultipleModelSvcs: any[]) => {
    return [].concat.apply([], sampleResponsesMultipleModelSvcs)
  })

}
