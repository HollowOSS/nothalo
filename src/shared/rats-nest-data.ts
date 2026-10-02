import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('rats-nest-data.json')
export default data.default
