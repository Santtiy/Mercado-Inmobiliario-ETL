# Mercado inmobiliario

Dashboard web estático para explorar el mercado inmobiliario de King County,
Washington.

## Despliegue en Vercel

Configura el proyecto de Vercel con estos valores:

- **Root Directory:** `.`
- **Framework Preset:** `Other`
- **Build Command:** vacío
- **Output Directory:** `.`
- **Install Command:** vacío

Vercel servirá directamente `index.html`. No se necesita Node, Python ni
backend.

## Desarrollo local

Desde la raíz del repositorio:

```powershell
python -m http.server 8000
```

Abre <http://localhost:8000>.

Los archivos `index.html`, `style.css`, `script.js` y `datos.json` son la
aplicación completa. `datos.json` es el artefacto generado por el ETL; el ETL
no forma parte de este repositorio.
