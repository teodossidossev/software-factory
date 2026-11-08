// The globals the typed page scripts (web/) use from the scripts still in static/ (SF-146). Each is
// typed as narrowly as its definition there allows; SF-147 to SF-150 remove a declaration when they
// convert the file that defines it. A global declaration file: no import or export.

// static/reports.js.
declare const SVG_NS: 'http://www.w3.org/2000/svg';
