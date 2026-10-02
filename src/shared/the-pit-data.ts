import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('the-pit-data.json')
export default data.default
