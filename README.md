# Exploración del Mercado Inmobiliario — King County, WA

Proyecto final de **Herramientas Computacionales**. Analiza las ventas de
viviendas de King County, Washington (2014–2015) mediante un proceso ETL con
PySpark, un modelo predictivo de precios, validación estadística con ANOVA, un
tablero en Power BI y un dashboard web estático desplegable en Vercel.

## Estructura del repositorio

```
.
├── ETL-Inmobiliario/
│   ├── etl/
│   │   ├── etl_inmobiliario.py     # ETL completo + modelo (PySpark MLlib)
│   │   └── exportar_web.py         # Genera dashboard-web/datos.json
│   ├── analisis/
│   │   └── anova.py                # ANOVA, Levene, Welch, Kruskal-Wallis, Tukey
│   ├── dashboard-web/              # Aplicación web estática (Vercel)
│   │   ├── index.html
│   │   ├── style.css
│   │   ├── script.js
│   │   └── datos.json
│   ├── salida/                     # Modelo estrella y resultados (CSV)
│   ├── limpieza_pyspark.py         # Limpieza inicial del dataset
│   ├── kc_house_data.csv           # Dataset original
│   ├── kc_house_clean.csv          # Dataset limpio
│   ├── zipcodes_king_county.csv    # Códigos postales / barrios
│   └── requirements.txt
├── graficos/                       # Boxplots generados por el análisis ANOVA
├── pbip/                           # Proyecto de Power BI en formato PBIP
├── MercadoInmobiliario_Final.pbix  # Tablero de Power BI
├── MercadoInmobiliario_Final.pbit  # Plantilla de Power BI
├── MercadoInmobiliario_Final.pdf   # Exportación del tablero
├── Informe_Final_Mercado_Inmobiliario.pdf
└── vercel.json                     # Configuración de despliegue de la web
```

## Flujo del proyecto

1. **Extracción** — lectura de `kc_house_data.csv` y `zipcodes_king_county.csv`
   con esquema explícito.
2. **Transformación** — limpieza, columnas derivadas (antigüedad, categorías de
   calidad, grupos de baños/habitaciones, etc.) y enriquecimiento con barrios.
3. **Modelado** — regresión lineal y Random Forest con PySpark MLlib.
4. **Carga** — modelo estrella en `salida/` (`fact_ventas`, `dim_fecha`,
   `dim_ubicacion`, `dim_vivienda`) más métricas, coeficientes y predicciones.
5. **Validación estadística** — ANOVA de uno y dos factores sobre `log(price)`
   con pruebas post hoc de Tukey HSD.
6. **Visualización** — tablero en Power BI y dashboard web.

### Resultados del modelo

| Modelo            | R²     | RMSE (USD) | MAE (USD) |
|-------------------|--------|------------|-----------|
| Regresión lineal  | 0.7246 | 187,735    | 124,562   |
| Random Forest     | 0.8369 | 144,480    | 86,447    |

## Requisitos

- Python 3.10+
- Java 17 o 21 (necesario para PySpark)

```powershell
cd ETL-Inmobiliario
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## Ejecución

Desde la carpeta `ETL-Inmobiliario/`:

```powershell
python etl/etl_inmobiliario.py   # ETL + modelo -> salida/
python analisis/anova.py         # Validación estadística -> salida/ y graficos/
python etl/exportar_web.py       # Actualiza dashboard-web/datos.json
```

## Dashboard web

La web es estática (HTML, CSS y JavaScript con Chart.js desde CDN) y lee los
datos de `datos.json`. No necesita backend ni proceso de build.

### Probar localmente

```powershell
cd ETL-Inmobiliario/dashboard-web
python -m http.server 8000
```

Abrir <http://localhost:8000>.

### Desplegar en Vercel

El archivo `vercel.json` de la raíz copia `ETL-Inmobiliario/dashboard-web` a
`dist/` durante el build y Vercel publica esa carpeta. No hace falta
configurar nada a mano.

1. Entrar a <https://vercel.com/new> e importar este repositorio de GitHub.
2. Dejar **Root Directory** en `./` (la raíz del repositorio), **Framework
   Preset** en `Other` y no sobrescribir los comandos de build/salida.
3. Pulsar **Deploy**.

Cada `git push` a `main` vuelve a desplegar la web automáticamente. Para
actualizar los datos, ejecutar `python etl/exportar_web.py`, hacer commit de
`datos.json` y subir los cambios.

## Power BI

Abrir `MercadoInmobiliario_Final.pbix` con Power BI Desktop. La carpeta `pbip/`
contiene el mismo informe en formato de proyecto (PBIP), apto para control de
versiones.

## Fuente de datos

[House Sales in King County, USA](https://www.kaggle.com/datasets/harlfoxem/housesalesprediction) (Kaggle).
