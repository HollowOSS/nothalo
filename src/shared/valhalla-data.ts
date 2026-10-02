import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('valhalla-data.json')
export default data.default
