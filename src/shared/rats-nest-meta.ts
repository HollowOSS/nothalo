import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('rats-nest-meta.json')
export default data.default
