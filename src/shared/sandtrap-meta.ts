import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('sandtrap-meta.json')
export default data.default
