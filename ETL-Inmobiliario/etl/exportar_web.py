"""
Exportación de datos para la página web del pitch (dashboard-web/datos.json).

Lee las tablas que generó el ETL en salida/ y las reúne en un único archivo JSON
que consume la página. Así los números de la web salen del ETL y no se escriben
a mano. Al final verifica que los indicadores principales coincidan con los del
informe de Power BI y termina con error si alguno no coincide.

Uso (desde la raíz del proyecto o desde cualquier carpeta):
    python etl/exportar_web.py
    python etl/exportar_web.py --web-dir C:\\ruta\\al\\repositorio-web
"""
import argparse
import json
import os
import sys

import pandas as pd

# ---------------------------------------------------------------------------
# Rutas del proyecto
# ---------------------------------------------------------------------------
RAIZ_PROYECTO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARPETA_SALIDA = os.path.join(RAIZ_PROYECTO, "salida")
RUTA_ORIGINAL = os.path.join(RAIZ_PROYECTO, "kc_house_data.csv")
CARPETA_WEB_POR_DEFECTO = os.path.join(RAIZ_PROYECTO, "dashboard-web")

# Columnas de cada venta que se exportan, en este orden
COLUMNAS_VENTAS = [
    "fecha", "anio", "periodo", "price", "sqft_living_m2", "bedrooms", "bathrooms",
    "grupo_banios", "grupo_habitaciones", "waterfront", "view", "grade",
    "categoria_calidad", "tipo_vivienda", "rango_precio", "yr_built",
    "decada_construccion", "renovada", "lat", "long", "zipcode",
]

# Columnas de texto que se codifican con un catálogo para reducir el peso del JSON
COLUMNAS_CATALOGO = [
    "periodo", "grupo_banios", "grupo_habitaciones", "categoria_calidad",
    "tipo_vivienda", "rango_precio", "decada_construccion",
]

# Correlaciones que no se muestran: son derivadas del precio o duplicadas en pies²
CORRELACIONES_EXCLUIDAS = ["outlier_precio", "precio_m2", "sqft_living", "sqft_lot"]

# Variables del modelo lineal sin control en el simulador: se fijan en su promedio
VARIABLES_FIJAS = ["waterfront", "view", "condition", "antiguedad", "lat"]

# Tamaño y semilla de la muestra de predicciones
TAMANIO_MUESTRA = 1500
SEMILLA = 42

# Valores del informe de Power BI: (valor esperado, tolerancia)
ESPERADOS = {
    "ventas": (21408, 0),
    "precio_promedio": (541810, 1),
    "precio_m2": (2799.7, 0.5),
    "prima_frente_agua_pct": (211.7, 0.1),
    "correlacion_m2_precio": (0.702, 0.0005),
    "precio_estimado_simulador": (454440, 5),
}

# Valores por defecto del simulador (iguales a los parámetros What-if)
SIMULADOR_DEFECTO = {"sqft_living_m2": 180, "bathrooms": 2, "bedrooms": 3, "grade": 7}


def leer_csv(nombre):
    """Lee un CSV de salida/ en UTF-8, con id y zipcode como texto."""
    ruta = os.path.join(CARPETA_SALIDA, nombre)
    return pd.read_csv(ruta, encoding="utf-8", dtype={"id": str, "zipcode": str})


def tabla_a_registros(df):
    """Convierte una tabla en lista de objetos, con NaN como null."""
    return json.loads(df.to_json(orient="records", force_ascii=False))


def numero_compacto(valor):
    """Devuelve un entero si el número no tiene decimales (el JSON pesa menos)."""
    if isinstance(valor, float) and valor.is_integer():
        return int(valor)
    return valor


def preparar_ventas(ventas):
    """Arma la tabla de ventas en formato compacto: columnas + filas como arreglos."""
    fechas = pd.to_datetime(ventas["date"])
    tabla = pd.DataFrame({
        "fecha": fechas.dt.strftime("%Y-%m-%d"),
        "anio": fechas.dt.year,
        "periodo": fechas.dt.strftime("%Y-%m"),
        "price": ventas["price"],
        "sqft_living_m2": ventas["sqft_living_m2"].round(1),
        "bedrooms": ventas["bedrooms"],
        "bathrooms": ventas["bathrooms"],
        "grupo_banios": ventas["grupo_banios"],
        "grupo_habitaciones": ventas["grupo_habitaciones"].astype(str),
        "waterfront": ventas["waterfront"].astype(int),
        "view": ventas["view"].astype(int),
        "grade": ventas["grade"].astype(int),
        "categoria_calidad": ventas["categoria_calidad"],
        "tipo_vivienda": ventas["tipo_vivienda"],
        "rango_precio": ventas["rango_precio"],
        "yr_built": ventas["yr_built"].astype(int),
        "decada_construccion": ventas["decada_construccion"],
        "renovada": ventas["renovada"].astype(int),
        "lat": ventas["lat"].round(4),
        "long": ventas["long"].round(4),
        "zipcode": ventas["zipcode"],
    })[COLUMNAS_VENTAS]

    if tabla.isna().any().any():
        nulos = tabla.columns[tabla.isna().any()].tolist()
        raise ValueError(f"Hay valores nulos en las columnas de ventas: {nulos}")

    # Las columnas de texto con pocos valores distintos se guardan como índices
    # sobre un catálogo: en la web, catalogos[columna][indice] devuelve el texto.
    codificada = tabla.astype(object)
    catalogos = {}
    for col in COLUMNAS_CATALOGO:
        valores = sorted(tabla[col].unique())
        catalogos[col] = valores
        posicion = {valor: i for i, valor in enumerate(valores)}
        codificada[col] = tabla[col].map(posicion)

    filas = [[numero_compacto(v) for v in fila]
             for fila in codificada.itertuples(index=False, name=None)]
    return tabla, {"columnas": COLUMNAS_VENTAS, "catalogos": catalogos, "filas": filas}


def preparar_ubicacion(ubicacion):
    """Diccionario zipcode -> ciudad, barrio y coordenadas promedio."""
    return {
        fila.zipcode: {
            "ciudad": fila.ciudad,
            "barrio": fila.barrio,
            "lat_promedio": round(float(fila.lat_promedio), 4),
            "long_promedio": round(float(fila.long_promedio), 4),
        }
        for fila in ubicacion.itertuples(index=False)
    }


def preparar_predicciones(predicciones):
    """Muestra reproducible de predicciones más el total de filas."""
    n = min(TAMANIO_MUESTRA, len(predicciones))
    muestra = predicciones.sample(n=n, random_state=SEMILLA)[["price", "precio_predicho"]]
    return {
        "total_filas": int(len(predicciones)),
        "columnas": ["price", "precio_predicho"],
        "muestra": [[numero_compacto(float(p)), round(float(q), 2)]
                    for p, q in muestra.itertuples(index=False, name=None)],
    }


def promedios_simulador(ventas):
    """Promedio, sobre todos los datos, de las variables sin control en el simulador."""
    return {var: float(ventas[var].mean()) for var in VARIABLES_FIJAS}


def precio_estimado(coeficientes, promedios, valores):
    """Misma fórmula que la medida DAX 'Precio Estimado'."""
    total = coeficientes["intercepto"]
    for var, valor in valores.items():
        total += coeficientes[var] * valor
    for var, valor in promedios.items():
        total += coeficientes[var] * valor
    return total


def calcular_verificacion(tabla, coeficientes, promedios):
    """Indicadores calculados sobre los datos exportados (lo mismo que verá la web)."""
    con_agua = tabla.loc[tabla["waterfront"] == 1, "price"].mean()
    sin_agua = tabla.loc[tabla["waterfront"] == 0, "price"].mean()
    return {
        "ventas": int(len(tabla)),
        "precio_promedio": float(tabla["price"].mean()),
        "precio_m2": float(tabla["price"].sum() / tabla["sqft_living_m2"].sum()),
        "prima_frente_agua_pct": float((con_agua / sin_agua - 1) * 100),
        "correlacion_m2_precio": float(tabla["sqft_living_m2"].corr(tabla["price"])),
        "precio_estimado_simulador": float(
            precio_estimado(coeficientes, promedios, SIMULADOR_DEFECTO)),
    }


def mostrar_verificacion(valores):
    """Imprime cada indicador junto al valor esperado. Devuelve True si todos coinciden."""
    etiquetas = {
        "ventas": "Ventas",
        "precio_promedio": "Precio promedio (USD)",
        "precio_m2": "Precio por m² (USD)",
        "prima_frente_agua_pct": "Prima frente al agua (%)",
        "correlacion_m2_precio": "Correlación m²–precio",
        "precio_estimado_simulador": "Precio estimado simulador (USD)",
    }
    todo_bien = True
    print("\nVerificación frente a Power BI")
    print("-" * 72)
    for clave, valor in valores.items():
        esperado, tolerancia = ESPERADOS[clave]
        coincide = abs(valor - esperado) <= tolerancia
        todo_bien &= coincide
        estado = "OK" if coincide else "NO COINCIDE"
        print(f"{etiquetas[clave]:<34}{valor:>14,.4f}   esperado {esperado:<10} ±{tolerancia:<7}{estado}")
    print("-" * 72)
    return todo_bien


def argumentos():
    """Lee la carpeta independiente donde se publicará el artefacto web."""
    parser = argparse.ArgumentParser(
        description="Genera datos.json para una copia independiente de la web."
    )
    parser.add_argument(
        "--web-dir",
        default=CARPETA_WEB_POR_DEFECTO,
        help=(
            "Carpeta que contiene la web. Se crea si no existe. "
            "Por defecto: dashboard-web/"
        ),
    )
    return parser.parse_args()


def main():
    args = argumentos()
    carpeta_web = os.path.abspath(args.web_dir)
    ruta_json = os.path.join(carpeta_web, "datos.json")

    # 1. Lectura de las salidas del ETL
    ventas = leer_csv("fact_ventas.csv")
    ubicacion = leer_csv("dim_ubicacion.csv")
    predicciones = leer_csv("predicciones.csv")
    coef_df = leer_csv("coeficientes_modelo.csv")
    correlaciones = leer_csv("correlaciones.csv")
    filas_originales = len(pd.read_csv(RUTA_ORIGINAL, usecols=[0]))

    # 2. Preparación de cada bloque del JSON
    tabla_ventas, ventas_json = preparar_ventas(ventas)
    coeficientes = dict(zip(coef_df["variable"], coef_df["coeficiente"]))
    promedios = promedios_simulador(ventas)
    correlaciones = correlaciones[~correlaciones["variable"].isin(CORRELACIONES_EXCLUIDAS)]
    fechas = pd.to_datetime(ventas["date"])

    datos = {
        "metadatos": {
            "fecha_min": fechas.min().strftime("%Y-%m-%d"),
            "fecha_max": fechas.max().strftime("%Y-%m-%d"),
            "filas_originales": int(filas_originales),
            "filas_limpias": int(len(ventas)),
        },
        "ventas": ventas_json,
        "ubicacion": preparar_ubicacion(ubicacion),
        "resultados_anova": tabla_a_registros(leer_csv("resultados_anova.csv")),
        "anova_dos_factores": tabla_a_registros(leer_csv("anova_dos_factores.csv")),
        "metricas_modelo": tabla_a_registros(leer_csv("metricas_modelo.csv")),
        "coeficientes_modelo": tabla_a_registros(coef_df),
        "correlaciones": tabla_a_registros(correlaciones),
        "predicciones": preparar_predicciones(predicciones),
        "promedios_simulador": promedios,
    }

    # 3. Escritura compacta (sin espacios) para que el archivo pese menos
    os.makedirs(carpeta_web, exist_ok=True)
    with open(ruta_json, "w", encoding="utf-8") as archivo:
        json.dump(datos, archivo, ensure_ascii=False, separators=(",", ":"), allow_nan=False)

    peso_mb = os.path.getsize(ruta_json) / (1024 * 1024)
    print(f"Archivo generado: {ruta_json} ({peso_mb:.2f} MB)")
    print(f"Período: {datos['metadatos']['fecha_min']} a {datos['metadatos']['fecha_max']}"
          f" | filas originales: {filas_originales:,} | filas limpias: {len(ventas):,}")

    # 4. Verificación contra los valores de Power BI
    valores = calcular_verificacion(tabla_ventas, coeficientes, promedios)
    if not mostrar_verificacion(valores):
        sys.exit("Error: los indicadores no coinciden con los de Power BI.")
    print("Todos los indicadores coinciden con Power BI.")


if __name__ == "__main__":
    main()
