# ChronoCut

Estimates how long a job takes on the Epilog Fusion laser cutters (Edgar,
George) before it is sent, and cleans up drawings for laser cutting (colours,
doubles, tiny segments, watermarks, joining curves).

**Everything runs in the browser.** PDF and SVG files are read and written on
the user's own computer (pdf.js and pdf-lib). Nothing is uploaded, and there
is no server-side code: hosting ChronoCut means serving a folder of static
files.

## Requirements

- [Node.js](https://nodejs.org/) 22 LTS or newer (includes npm). Only needed
  to build or develop, not to use a hosted copy.
- A current browser (Chrome, Edge, Firefox, Safari).

## Windows

### Quick start

Double-click `ChronoCut-Start.bat` in the project folder. It installs the
packages on the first run, starts ChronoCut and opens
http://localhost:5173/. Close the window "ChronoCut" to stop it.

### Manually

In a terminal in the `frontend` folder:

```sh
npm install
npm run dev
```

ChronoCut then runs on http://localhost:5173/.

## Linux

In a terminal in the `frontend` folder:

```sh
npm install
npm run dev
```

ChronoCut then runs on http://localhost:5173/.

## Linux server (Docker)

For running ChronoCut permanently on a server, e.g. for everyone in the
workshop. The image builds the app and serves it with nginx; it only hands
out files and never sees a drawing.

```sh
git clone <repository-url> chronocut
cd chronocut
docker compose up -d --build
```

ChronoCut is then reachable on port 8080: `http://<server>:8080/`.

Without compose:

```sh
docker build -t chronocut .
docker run -d --name chronocut -p 8080:8080 --restart unless-stopped chronocut
```

**Updating** after a `git pull`:

```sh
docker compose up -d --build
```

**Notes for the server admin**

- 1 CPU core and 256 MB RAM are plenty; the work happens in the browsers.
- HTTPS: put it behind the existing reverse proxy (or let the proxy terminate
  TLS and forward to port 8080). No WebSockets, no upload size limits needed:
  the app only receives GET requests.
- The app works from a sub path too (e.g. `https://server/chronocut/`), the
  build uses relative paths.
- The whole app is about 6 MB (PDF engine and substitute fonts included).
  Browsers cache it after the first visit. The included nginx config serves
  it compressed and with long cache times (`docker/nginx.conf`).

### Without Docker

Any web server for static files works (nginx, Apache, IIS):

```sh
cd frontend
npm ci
npm run build
```

and copy the contents of `frontend/dist/` to the web server (including the
`pdfjs/` folder: substitute fonts for PDFs that do not embed theirs). Opening
`dist/index.html` directly from disk does not work: browsers only run the PDF
engine when the page comes from a web server.

## Watermarks

ChronoCut can remove watermarks that would otherwise be engraved or cut along
with the drawing, for example the "ARCHICAD BILDUNGSVERSION" stamp that
educational CAD licences put on every page. This only changes the copy that is
sent to the laser cutter. It is not meant to hide where a drawing comes from or
to pass off educational-licence output as commercial work; the licence terms of
your CAD software still apply. Only watermarks stored as text in the file are
detected, plus the Archicad stamp image.

## Adding a printer

Printer profiles (machine specs and material presets) are the XML files in
`printers/`. They are bundled into the app when it is built, so after adding
or changing one, rebuild (`npm run build`, or `docker compose up -d --build`).
`printers/Converter.py` turns a folder of Epilog `*.DAT` presets into such a
file.

## Project layout

| Folder | Contents |
|---|---|
| `frontend/` | The app (Vue 3, Three.js). Time model in `src/toolpath.js` and `src/calibration.js`, PDF reading/writing in `src/pdf/`. |
| `printers/` | Printer and material profiles (XML) and the preset converter. |
| `laser time calibration/` | Calibration files, measurement protocol and test files for the tools. |
| `docker/` | nginx configuration for the container. |

## Third-party software

All libraries are under permissive licences, which fit ChronoCut's own MIT
licence. Their licence texts
must stay with the app (they are in `node_modules/<package>/` and, for the
files shipped as-is, in `dist/pdfjs/`).

| Component | Used for | Licence |
|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | reading PDFs | Apache 2.0 |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | writing PDFs | MIT |
| [opentype.js](https://github.com/opentypejs/opentype.js) | text to outlines | MIT |
| [fflate](https://github.com/101arrowz/fflate) | PNG compression | MIT |
| Vue, Three.js, axios, mitt, pinia, vue-router | app | MIT |
| Inter (`@fontsource/inter`) | UI font | SIL OFL 1.1 |
| Foxit fonts (shipped by pdf.js) | substitute fonts | BSD-style (PDFium) |
| Liberation Sans (shipped by pdf.js) | substitute font | GPL 2 with font exception, a separate data file |
| JBIG2 / OpenJPEG / QCMS decoders (shipped by pdf.js) | rare image formats | BSD / MIT |

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 BlackCube4 and JulianDKal.
