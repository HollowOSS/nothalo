import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('sandtrap-data.json')
export default data.default
