import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('blood-gulch-meta.json')
export default data.default
