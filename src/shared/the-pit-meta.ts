import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('the-pit-meta.json')
export default data.default
