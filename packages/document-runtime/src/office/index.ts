export { readDocx } from "./docx.ts"
export { readPptx } from "./pptx.ts"
export { readXlsx } from "./xlsx.ts"
export {
  defaultLimits as officeDefaultLimits,
  encodeStructuredText,
  limitStructuredText,
  validateInputBytes,
  type Limits as OfficeLimits,
  type Section as OfficeSection,
  type StructuredText as OfficeStructuredText,
} from "./common.ts"
