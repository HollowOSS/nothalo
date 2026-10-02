import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('valhalla-meta.json')
export default data.default
