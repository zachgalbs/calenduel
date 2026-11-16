// Deployed entry point. Only handlers may be exported from it: the runtime
// rejects other named exports (index.js exports rubric constants for tests).
import worker from './index.js'

export { IpadRelay } from './relay.js'
export default worker
