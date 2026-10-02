import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('narrows-data.json')
export default data.default
