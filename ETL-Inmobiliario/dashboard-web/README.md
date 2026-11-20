# Web del mercado inmobiliario

Esta carpeta es una aplicación web estática independiente. Para desplegarla
solo se necesitan estos archivos:

- `index.html`
- `style.css`
- `script.js`
- `datos.json`

El servidor debe usar `dashboard-web/` como raíz pública. No necesita Python,
Node ni un backend; `datos.json` se carga desde el navegador y Chart.js se
carga desde su CDN.

## Probar localmente

Desde esta carpeta:

```powershell
python -m http.server 8000
```

Luego abre <http://localhost:8000>.

## Actualizar los datos desde el ETL

El ETL y la web pueden estar en carpetas o repositorios separados. Ejecuta
el exportador indicando la carpeta local de la web:

```powershell
python etl\exportar_web.py --web-dir "C:\ruta\al\repositorio\web"
```

El comando solo reemplaza `datos.json`; no copia código del ETL a la web.
Después de generarlo, sube ese archivo al repositorio de la web y vuelve a
desplegar el sitio estático.

Si la web permanece dentro de este proyecto, basta con ejecutar:

```powershell
python etl\exportar_web.py
```
