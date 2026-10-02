import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('blood-gulch-data.json')
export default data.default
