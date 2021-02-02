/**
 * @jest-environment node
 */
import axios from 'axios'
import { rest } from '../rest'
import { setupServer } from './setupServer'

// const materialsModelEndpoint = "http://127.0.0.1:8080/"
const materialsModelEndpoint = "https://prodmodelsvc.azurewebsites.net"
const localMaterialsEndpoint = "http://127.0.0.1:5000/resources?year=2020&course=20002"
const otherMaterialsEndpoint = "http://127.0.0.1:5000/"

const server = setupServer(
  rest.get(localMaterialsEndpoint, (req, res, ctx) => {
    return res(ctx.json([]))
  }, materialsModelEndpoint),
  rest.get(otherMaterialsEndpoint, (req, res, ctx) => {
    return res(ctx.json([]))
  }, materialsModelEndpoint),
)

beforeAll(() => {
  // jest.spyOn(global.console, 'log').mockImplementation()
  server.listen()
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
  await axios.get(localMaterialsEndpoint)
  await axios.get(otherMaterialsEndpoint)
  let runtimes = await server.runtimes();
  console.log(runtimes);

  // Runtime handlers are prepended to the list of handlers
  // and they DON'T remove the handlers they may override.
  // expect(console.log).toBeCalledTimes(8)
})
