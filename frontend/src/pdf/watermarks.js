// Watermark phrases (formerly backend/watermarks.xml).
//
// Matching is case-insensitive (spaces optional) and looks for the phrase
// anywhere in a text line; the WHOLE line then counts as watermark. Every
// vector/text object inside it is TAGGED on load (not removed): the user sees
// the watermark, and the "Wasserzeichen entfernen" button removes it on
// request. Add one string per phrase.
//
// Only works when the watermark is real text in the PDF. Watermarks drawn as
// plain lines (e.g. some CAD plot stamps) cannot be found this way.
//
// GSEducationalVersion is the invisible white marker Archicad's educational
// version puts on every exported page. When it is present, the visible
// "ARCHICAD BILDUNGSVERSION" stamp image is offered for removal too (that one
// is a picture, not text - see imageEntry() in extract.js).
export const WATERMARKS = [
  // Archicad / Graphisoft
  'GSEducationalVersion',
  'BILDUNGSVERSION',
  // Educational / student licences (Autodesk, Vectorworks, Allplan, ...)
  'EDUCATIONAL VERSION',
  'EDUCATIONAL PRODUCT',
  'STUDENT VERSION',
  'STUDENTENVERSION',
  'STUDENT EDITION',
  'NOT FOR COMMERCIAL USE',
  'NICHT FÜR KOMMERZIELLE',
  // Trial / demo builds
  'TRIAL VERSION',
  'EVALUATION VERSION',
  'DEMO VERSION',
  'TESTVERSION',
]
