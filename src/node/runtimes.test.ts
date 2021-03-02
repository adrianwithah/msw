/**
 * @jest-environment node
 */
import axios from 'axios'
import { rest } from '../rest'
import { setupServer } from './setupServer'

const materialsModelEndpoint = "http://127.0.0.1:8080/"
// const materialsModelEndpoint = "https://prodmodelsvc.azurewebsites.net"
// const localMaterialsEndpoint = "http://127.0.0.1:5000/resources?year=2020&course=20002"
const otherMaterialsEndpoint = "http://localhost:5000/resources"

const server = setupServer(
  // rest.get(localMaterialsEndpoint, (req, res, ctx) => {
  //   return res(ctx.json([]))
  // }, {
  //   endpoint: materialsModelEndpoint,
  //   scale: 0.5
  // }),
  rest.get(otherMaterialsEndpoint, (req, res, ctx) => {
    return res(ctx.json([]))
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

afterEach(() => {
  // jest.resetAllMocks()
  server.resetHandlers()
})

afterAll(() => {
  // jest.restoreAllMocks()
  server.close()
})

test('respects runtime request handlers when listing handlers', async () => {
  // await axios.get(localMaterialsEndpoint)
  await axios.get(otherMaterialsEndpoint)
  let runtimes = await server.runtimes();
  console.log(runtimes);

  // Runtime handlers are prepended to the list of handlers
  // and they DON'T remove the handlers they may override.
  // expect(console.log).toBeCalledTimes(8)
})
