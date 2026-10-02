import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('epitaph-meta.json')
export default data.default
