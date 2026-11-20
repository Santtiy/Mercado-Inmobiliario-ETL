"""
Validación estadística del proyecto "Exploración del Mercado Inmobiliario" con ANOVA.

Para cada factor se prueba la hipótesis:
    H0: el precio medio es igual en todos los grupos del factor.
    H1: al menos un grupo tiene un precio medio distinto.

Se trabaja con log(price) y no con el precio directo porque el precio tiene una
distribución muy asimétrica (pocas mansiones muy caras). El logaritmo la vuelve
más simétrica y parecida a una normal, que es uno de los supuestos del ANOVA.

Requiere haber corrido antes el ETL (python etl/etl_inmobiliario.py).
Uso:
    python analisis/anova.py
Genera en salida/:
    resultados_anova.csv, tukey_<factor>.csv, anova_dos_factores.csv y graficos/*.png
"""
import os
import warnings

import matplotlib
matplotlib.use("Agg")  # se dibuja directo a archivo, sin abrir ventanas
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
from scipy import stats
from statsmodels.formula.api import ols
from statsmodels.stats.anova import anova_lm
from statsmodels.stats.multicomp import pairwise_tukeyhsd
from statsmodels.stats.oneway import anova_oneway

# ---------------------------------------------------------------------------
# Rutas (relativas a la raíz del proyecto, calculadas desde este archivo)
# ---------------------------------------------------------------------------
RAIZ_PROYECTO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARPETA_SALIDA = os.path.join(RAIZ_PROYECTO, "salida")
CARPETA_GRAFICOS = os.path.join(CARPETA_SALIDA, "graficos")

ALFA = 0.05  # nivel de significación: 5 % de probabilidad de rechazar H0 siendo verdadera

# Orden lógico de los grupos (para tablas y gráficos). Los factores que no
# figuran acá se ordenan alfabéticamente.
ORDEN_GRUPOS = {
    "frente_agua": ["No", "Sí"],
    "view": [0, 1, 2, 3, 4],
    "categoria_calidad": ["Económica", "Estándar", "Alta", "Lujo"],
    "tipo_vivienda": ["Una planta", "Una planta con sótano", "Dos plantas",
                      "Tres o más plantas"],
    "grupo_banios": ["1 o menos", "1.25-2", "2.25-3", "3.25-4", "Más de 4"],
    "grupo_habitaciones": ["1", "2", "3", "4", "5", "6 o más"],
    "rango_antiguedad": ["0-10 años", "11-25 años", "26-50 años", "51-75 años",
                         "Más de 75 años"],
}

# Factores a los que se les hace Tukey HSD (comparación de a pares)
FACTORES_TUKEY = ["categoria_calidad", "tipo_vivienda", "grupo_banios"]


def cargar_datos() -> pd.DataFrame:
    """Lee la tabla de hechos, le agrega la ciudad y crea las variables del análisis."""
    # id y zipcode como texto para no perder ceros a la izquierda;
    # grupo_habitaciones como texto porque sus etiquetas son "1", "2", ...
    tipos = {"id": str, "zipcode": str, "grupo_habitaciones": str}
    hechos = pd.read_csv(os.path.join(CARPETA_SALIDA, "fact_ventas.csv"), dtype=tipos)
    ubicacion = pd.read_csv(os.path.join(CARPETA_SALIDA, "dim_ubicacion.csv"),
                            dtype={"zipcode": str})

    # La ciudad está en la dimensión de ubicación: se trae con un join por zipcode
    df = hechos.merge(ubicacion[["zipcode", "ciudad"]], on="zipcode", how="left")

    # Variable respuesta: logaritmo natural del precio
    df["log_price"] = np.log(df["price"])

    # Rango de antigüedad de la vivienda al momento de la venta
    df["rango_antiguedad"] = pd.cut(
        df["antiguedad"], bins=[-1, 10, 25, 50, 75, np.inf],
        labels=ORDEN_GRUPOS["rango_antiguedad"]).astype(str)
    return df


def grupos_del_factor(df: pd.DataFrame, factor: str) -> list:
    """Devuelve los nombres de los grupos en su orden lógico."""
    presentes = df[factor].dropna().unique().tolist()
    if factor in ORDEN_GRUPOS:
        return [g for g in ORDEN_GRUPOS[factor] if g in presentes]
    return sorted(presentes)


def analizar_factor(df: pd.DataFrame, factor: str) -> dict:
    """Aplica ANOVA, eta², Levene, Welch y Kruskal-Wallis a un factor."""
    nombres = grupos_del_factor(df, factor)
    muestras = [df.loc[df[factor] == g, "log_price"].to_numpy() for g in nombres]

    # ANOVA de un factor: compara la variación ENTRE grupos con la variación
    # DENTRO de los grupos. Un F grande indica que las medias difieren.
    f_estadistico, p_anova = stats.f_oneway(*muestras)

    # Eta cuadrado: proporción de la variación total del log(precio) que
    # explica el factor. Va de 0 a 1 (0,14 o más se considera un efecto grande).
    media_general = df["log_price"].mean()
    ss_entre = sum(len(m) * (m.mean() - media_general) ** 2 for m in muestras)
    ss_total = ((df["log_price"] - media_general) ** 2).sum()
    eta2 = ss_entre / ss_total

    # Levene: H0 = las varianzas de los grupos son iguales (supuesto del ANOVA).
    # Si p < 0,05 ese supuesto no se cumple y conviene mirar Welch y Kruskal-Wallis.
    _, p_levene = stats.levene(*muestras)

    # Welch: versión del ANOVA que NO supone varianzas iguales
    welch = anova_oneway(df["log_price"], df[factor], use_var="unequal")

    # Kruskal-Wallis: alternativa no paramétrica (compara rangos, no medias),
    # que no necesita normalidad ni varianzas iguales
    _, p_kruskal = stats.kruskal(*muestras)

    conclusion = "Se rechaza H0" if p_anova < ALFA else "No se rechaza H0"
    return {"factor": factor, "n_grupos": len(nombres), "F": f_estadistico,
            "p_valor": p_anova, "eta2": eta2, "levene_p": p_levene,
            "welch_p": welch.pvalue, "kruskal_p": p_kruskal, "conclusion": conclusion}


def tukey(df: pd.DataFrame, factor: str) -> pd.DataFrame:
    """Tukey HSD: indica qué pares de grupos tienen medias distintas entre sí."""
    resultado = pairwise_tukeyhsd(endog=df["log_price"], groups=df[factor], alpha=ALFA)
    tabla = resultado.summary().data  # primera fila = encabezados
    tukey_df = pd.DataFrame(tabla[1:], columns=tabla[0])
    # Columnas: group1, group2, meandiff (diferencia de medias del log),
    # p-adj (p-valor ajustado por comparaciones múltiples), lower/upper
    # (intervalo de confianza) y reject (True = esos dos grupos difieren).
    return tukey_df


def anova_dos_factores(df: pd.DataFrame) -> pd.DataFrame:
    """ANOVA de dos factores: baños, habitaciones y su interacción.

    La interacción responde: ¿el efecto de sumar baños depende de cuántas
    habitaciones tiene la casa? Se usa suma de cuadrados tipo II, adecuada
    cuando los grupos tienen tamaños distintos.
    """
    with warnings.catch_warnings():
        # Algunas combinaciones no existen (por ejemplo, 1 habitación y más de
        # 4 baños) y statsmodels avisa que la matriz del modelo es singular.
        # Por eso los grados de libertad de la interacción (20) son nominales:
        # los reales son algo menos, porque esas celdas vacías no aportan.
        warnings.simplefilter("ignore")
        modelo = ols("log_price ~ C(grupo_banios) * C(grupo_habitaciones)", data=df).fit()
        tabla = anova_lm(modelo, typ=2)
    tabla.index = ["grupo_banios", "grupo_habitaciones", "interaccion", "residuos"]
    tabla.index.name = "fuente"
    tabla = tabla.rename(columns={"sum_sq": "suma_cuadrados", "df": "grados_libertad",
                                  "PR(>F)": "p_valor"})
    return tabla.reset_index()


def graficar_boxplot(df: pd.DataFrame, factor: str):
    """Boxplot de log(precio) por grupo: muestra mediana, dispersión y atípicos."""
    orden = grupos_del_factor(df, factor)
    ancho = max(7, 0.6 * len(orden))  # ciudad tiene muchos grupos: gráfico más ancho
    fig, ax = plt.subplots(figsize=(ancho, 5))
    sns.boxplot(data=df, x=factor, y="log_price", order=orden, ax=ax, color="#7FA7CC")
    ax.set_title(f"log(precio) según {factor}")
    ax.set_xlabel(factor)
    ax.set_ylabel("log(precio)")
    if len(orden) > 6:
        ax.tick_params(axis="x", rotation=60)
    fig.tight_layout()
    fig.savefig(os.path.join(CARPETA_GRAFICOS, f"boxplot_{factor}.png"), dpi=120)
    plt.close(fig)


def main():
    os.makedirs(CARPETA_GRAFICOS, exist_ok=True)
    df = cargar_datos()
    print(f"Filas analizadas: {len(df)}")

    factores = ["frente_agua", "view", "categoria_calidad", "tipo_vivienda",
                "grupo_banios", "grupo_habitaciones", "rango_antiguedad", "ciudad"]

    # 1) ANOVA de un factor para cada variable
    resultados = pd.DataFrame([analizar_factor(df, f) for f in factores])
    resultados = resultados.sort_values("eta2", ascending=False)
    resultados.to_csv(os.path.join(CARPETA_SALIDA, "resultados_anova.csv"),
                      index=False, encoding="utf-8")

    # 2) Tukey HSD para los factores seleccionados
    for factor in FACTORES_TUKEY:
        tabla_tukey = tukey(df, factor)
        tabla_tukey.to_csv(os.path.join(CARPETA_SALIDA, f"tukey_{factor}.csv"),
                           index=False, encoding="utf-8")
        distintos = int(tabla_tukey["reject"].sum())
        print(f"Tukey {factor}: {distintos} de {len(tabla_tukey)} pares difieren")

    # 3) ANOVA de dos factores (baños × habitaciones)
    dos_factores = anova_dos_factores(df)
    dos_factores.to_csv(os.path.join(CARPETA_SALIDA, "anova_dos_factores.csv"),
                        index=False, encoding="utf-8")

    # 4) Boxplots
    for factor in factores:
        graficar_boxplot(df, factor)

    # 5) Resumen en consola
    pd.set_option("display.width", 160)
    formato = resultados.copy()
    formato["F"] = formato["F"].map("{:.1f}".format)
    for columna in ["p_valor", "levene_p", "welch_p", "kruskal_p"]:
        formato[columna] = formato[columna].map("{:.2e}".format)
    formato["eta2"] = formato["eta2"].map("{:.3f}".format)
    print("\nANOVA de un factor sobre log(precio), alfa = 0,05:")
    print(formato.to_string(index=False))
    print("\nANOVA de dos factores (baños × habitaciones):")
    print(dos_factores.to_string(index=False))
    print(f"\nArchivos guardados en {CARPETA_SALIDA}")


if __name__ == "__main__":
    main()
