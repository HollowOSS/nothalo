import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('epitaph-data.json')
export default data.default
