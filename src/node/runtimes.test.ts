/**
 * @jest-environment node
 */
import axios from 'axios'
import { rest } from '../rest'
import { PerformanceTest } from './createSetupServer'
import { setupServer } from './setupServer'

const materialsModelEndpoint = "http://localhost:8080/"
// const materialsModelEndpoint = "https://prodmodelsvc.azurewebsites.net"
const localMaterialsEndpoint = "http://127.0.0.1:5000/resources?year=2020&course=20002"
const otherMaterialsEndpoint = "http://127.0.0.1:5000/resources"

const server = setupServer(
  rest.get(localMaterialsEndpoint, (req, res, ctx) => {
    return res(ctx.json([]))
  }, {
    endpoint: materialsModelEndpoint
  }),
  rest.get(otherMaterialsEndpoint, (req, res, ctx) => {
    return res(ctx.json(["Hi", "I'm", "an", "array"]))
  }, {
    endpoint: materialsModelEndpoint
  }),
)

beforeAll(async () => {
  // jest.spyOn(global.console, 'log').mockImplementation()
  await server.registerModelSampleDelays()
  server.listen()
  jest.setTimeout(50000)
})

beforeEach(() => {
  server.startVirtualTimeline()
})

afterEach(() => {
  // jest.resetAllMocks()
  server.resetHandlers()
  server.stopVirtualTimeline()
})

afterAll(() => {
  // jest.restoreAllMocks()
  server.close()
})

// test('Case 1 (parallel issue, sequential await)', async () => {
  
//   let serviceClient = server.getTrackedServiceClient()

//   let firstRequest = serviceClient.issueHttpRequest(localMaterialsEndpoint)
//   let secondRequest = serviceClient.issueHttpRequest(otherMaterialsEndpoint)

//   console.log("Started promises")
//   let outerPromise = firstRequest.unwrap((response: Response) => {
//     console.log(response)
//     console.log("Awaited somePromise")
//     let innerPromise = secondRequest.unwrap((response) => {
//       console.log("Awaited otherPromise")
//     })
//   })

//   await new Promise((res, rej) => setTimeout(res, 5000))
//   console.log(server.getVirtualTimeline().getEvents())
// })

test (
  "Custom",
  PerformanceTest(() => {
    let serviceClient = server.getTrackedServiceClient()
    let firstRequest = serviceClient.issueHttpRequest(localMaterialsEndpoint)
    let secondRequest = serviceClient.issueHttpRequest(otherMaterialsEndpoint)

    let firstPromise = firstRequest.unwrap((response: Response) => {
      let firstInnerRequest = serviceClient.issueHttpRequest(otherMaterialsEndpoint)
      return firstInnerRequest.unwrap((response: Response) => {
        console.log("Done first!")
      })
    })

    let secondPromise = secondRequest.unwrap((response: Response) => {
      let secondInnerRequest = serviceClient.issueHttpRequest(localMaterialsEndpoint)
      return secondInnerRequest.unwrap((response: Response) => {
        console.log("Done second!")
      })
    })

    // Wait for all promises to resolve
    return Promise.all([firstPromise, secondPromise]).then(() => console.log(server.getVirtualTimelineEvents()))
  }, {
    // Month is 0-indexed.
    totalRuntimeExpectation: 0.001,
    mockServer: server,
    mutePerformanceCheckTill: new Date(Date.UTC(2021, 1, 25))
  }), 50000)

// test('Case 2 (sequential issue, sequential await)', async () => {
  
//   let serviceClient = server.getTrackedServiceClient()

//   let firstRequest = serviceClient.issueHttpRequest(localMaterialsEndpoint)

//   console.log("Started promises")
//   let outerPromise = firstRequest.unwrap((response: Response) => {
//     console.log("Awaited somePromise")
//     let innerPromise = serviceClient.issueHttpRequest(otherMaterialsEndpoint)
//       .unwrap((response) => {
//         console.log("Awaited otherPromise")
//       })

//     return innerPromise
//   })

//   return outerPromise.then(() => {
//     console.log(server.getVirtualTimeline().getEvents())
//   })
// })

// test('Case 3 (independent)', async () => {
  
//   let serviceClient = server.getTrackedServiceClient()

//   let firstRequest = serviceClient.issueHttpRequest(localMaterialsEndpoint)

//   console.log("Started first request")
//   firstRequest.unwrap((response: Response) => {
//     console.log(response)
//     console.log("Awaited somePromise")
//   })

//   let secondRequest = serviceClient.issueHttpRequest(otherMaterialsEndpoint)
//   console.log("Started second request")
//   secondRequest.unwrap((response: Response) => {
//     console.log(response)
//     console.log("Awaited otherPromise")
//   })

//   await new Promise((res, rej) => setTimeout(res, 5000))
//   console.log(server.getVirtualTimeline().getEvents())
// })

// We must convert await code to then code and replace then with unwrap.
// test('Case 4 (custom)', () => {
  
//   let serviceClient = server.getTrackedServiceClient()

//   let firstRequest = serviceClient.issueHttpRequest(localMaterialsEndpoint)

//   console.log("Started first request")
//   console.log("Taking 7 seconds for other work")
  
//   let someWork = new Promise((res, rej) => setTimeout(res, 7000))
//   return someWork.then(() => {
//     let finalPromise = firstRequest.unwrap((response: Response) => {
//       console.log(response)
//       console.log("Awaited somePromise")

//       console.log(server.getVirtualTimeline().getEvents())
//       console.log(server.getVirtualTimeline().getDuration())
//     })

//     return finalPromise
//     // return new Promise((res, rej) => setTimeout(res, 5000))
//   })

//   return new Promise((res, rej) => setTimeout(res, 5000))
// })
