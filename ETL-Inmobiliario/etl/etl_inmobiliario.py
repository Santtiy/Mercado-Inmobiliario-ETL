"""
ETL del proyecto "Exploración del Mercado Inmobiliario" (King County, WA, 2014-2015).

Etapas:
    1. extraer()        -> lee kc_house_data.csv y zipcodes_king_county.csv con esquema explícito.
    2. transformar()    -> limpieza, columnas derivadas y enriquecimiento con barrios.
    3. entrenar_modelo() -> regresión lineal con PySpark MLlib (y Random Forest para comparar).
    4. cargar()         -> escribe el modelo estrella en salida/ (CSV y, si se puede, Parquet).

Uso (desde la raíz del proyecto o desde cualquier carpeta):
    python etl/etl_inmobiliario.py
"""
import glob
import os
import shutil
import sys

from pyspark.ml.evaluation import RegressionEvaluator
from pyspark.ml.feature import VectorAssembler
from pyspark.ml.regression import LinearRegression, RandomForestRegressor
from pyspark.sql import SparkSession, DataFrame, Window, functions as F
from pyspark.sql.types import (StructType, StructField, StringType, DoubleType,
                               IntegerType, LongType, NumericType)

# ---------------------------------------------------------------------------
# Rutas del proyecto
# ---------------------------------------------------------------------------
# Se calculan a partir de la ubicación de este archivo (etl/etl_inmobiliario.py),
# así el script funciona igual sin importar desde qué carpeta se lo ejecute.
RAIZ_PROYECTO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUTA_VENTAS = os.path.join(RAIZ_PROYECTO, "kc_house_data.csv")
RUTA_BARRIOS = os.path.join(RAIZ_PROYECTO, "zipcodes_king_county.csv")
CARPETA_SALIDA = os.path.join(RAIZ_PROYECTO, "salida")

# Factor de conversión de pies cuadrados a metros cuadrados
PIE2_A_M2 = 0.092903

# ---------------------------------------------------------------------------
# Esquemas explícitos
# ---------------------------------------------------------------------------
# Se definen a mano en lugar de usar inferSchema porque:
#   - id y zipcode deben ser texto: si Spark los toma como número se pierden
#     los ceros a la izquierda (por ejemplo, el id "0627300145").
#   - date viene como "20141013T000000" y se deja como texto para parsearlo después.
ESQUEMA_VENTAS = StructType([
    StructField("id", StringType()),
    StructField("date", StringType()),
    StructField("price", DoubleType()),
    StructField("bedrooms", IntegerType()),
    StructField("bathrooms", DoubleType()),
    StructField("sqft_living", IntegerType()),
    StructField("sqft_lot", IntegerType()),
    StructField("floors", DoubleType()),
    StructField("waterfront", IntegerType()),
    StructField("view", IntegerType()),
    StructField("condition", IntegerType()),
    StructField("grade", IntegerType()),
    StructField("sqft_above", IntegerType()),
    StructField("sqft_basement", IntegerType()),
    StructField("yr_built", IntegerType()),
    StructField("yr_renovated", IntegerType()),
    StructField("zipcode", StringType()),
    StructField("lat", DoubleType()),
    StructField("long", DoubleType()),
    StructField("sqft_living15", IntegerType()),
    StructField("sqft_lot15", IntegerType()),
])

ESQUEMA_BARRIOS = StructType([
    StructField("zipcode", StringType()),
    StructField("ciudad", StringType()),
    StructField("barrio", StringType()),
])


def crear_sesion() -> SparkSession:
    """Crea la sesión de Spark en modo local usando todos los núcleos disponibles."""
    # En Windows, Spark lanza procesos de Python aparte (los "workers").
    # Se le indica que use el mismo intérprete que está corriendo este script
    # para evitar errores si hay varias versiones de Python instaladas.
    os.environ.setdefault("PYSPARK_PYTHON", sys.executable)
    os.environ.setdefault("PYSPARK_DRIVER_PYTHON", sys.executable)

    spark = (SparkSession.builder
             .appName("ETLMercadoInmobiliario")
             .master("local[*]")
             # Por defecto Spark reparte cada agrupación o join en 200 particiones,
             # pensado para clusters grandes. Con unas 21 mil filas eso solo
             # agrega sobrecarga, así que se usan 8.
             .config("spark.sql.shuffle.partitions", "8")
             # Se ocultan las barras de progreso para que la consola muestre solo los conteos
             .config("spark.ui.showConsoleProgress", "false")
             .getOrCreate())
    spark.sparkContext.setLogLevel("ERROR")  # se ocultan los mensajes informativos de Spark
    return spark


# ===========================================================================
# 1. EXTRACCIÓN
# ===========================================================================
def extraer(spark: SparkSession) -> tuple[DataFrame, DataFrame]:
    """Lee los dos archivos de origen y devuelve (ventas, barrios)."""
    ventas = spark.read.csv(RUTA_VENTAS, header=True, schema=ESQUEMA_VENTAS)
    barrios = spark.read.csv(RUTA_BARRIOS, header=True, schema=ESQUEMA_BARRIOS)
    return ventas, barrios


# ===========================================================================
# 2. TRANSFORMACIÓN
# ===========================================================================
def limpiar(df: DataFrame, conteos: list) -> DataFrame:
    """Aplica la limpieza de datos y registra cuántas filas quedan tras cada paso."""

    # 2.1 Nulos y duplicados exactos. El diagnóstico mostró que no hay,
    #     pero se verifica igual para que el ETL sea robusto ante datos nuevos.
    df = df.dropna().dropDuplicates()
    conteos.append(("Sin nulos ni duplicados exactos", df.count()))

    # 2.2 Fecha: "20141013T000000" -> se toman los primeros 8 caracteres
    #     ("20141013") y se convierten a tipo fecha.
    df = df.withColumn("date", F.to_date(F.substring("date", 1, 8), "yyyyMMdd"))

    # 2.3 Propiedades vendidas más de una vez (176 ids, 177 filas extra).
    #     Se conserva solo la venta más reciente de cada propiedad, para tener
    #     una fila por vivienda. Antes se guarda en n_ventas cuántas veces se vendió.
    por_id = Window.partitionBy("id")
    por_id_mas_reciente = por_id.orderBy(F.col("date").desc())
    df = (df.withColumn("n_ventas", F.count("*").over(por_id))
            .withColumn("orden", F.row_number().over(por_id_mas_reciente))
            .filter(F.col("orden") == 1)
            .drop("orden"))
    conteos.append(("Una venta por propiedad (la más reciente)", df.count()))

    # 2.4 Error de tipeo conocido: una casa con 33 dormitorios en solo 1.620 sqft.
    #     Por la superficie, claramente son 3 dormitorios.
    df = df.withColumn(
        "bedrooms",
        F.when((F.col("bedrooms") == 33) & (F.col("sqft_living") < 2000), 3)
         .otherwise(F.col("bedrooms")))

    # 2.5 Valores imposibles: viviendas sin dormitorios o sin baños,
    #     y superficies habitables irreales (menos de 300 sqft, unos 28 m²).
    df = df.filter((F.col("bedrooms") > 0) & (F.col("bathrooms") > 0))
    conteos.append(("Sin 0 dormitorios / 0 baños", df.count()))
    df = df.filter(F.col("sqft_living") >= 300)
    conteos.append(("Superficie habitable >= 300 sqft", df.count()))

    # 2.6 Coherencia de años: se descartan las casas vendidas antes de que
    #     terminara su construcción (preventas, yr_built mayor al año de venta).
    df = df.filter(F.col("yr_built") <= F.year("date"))
    conteos.append(("yr_built <= año de venta", df.count()))

    # 2.7 yr_renovated = 0 significa "nunca renovada". Se reemplaza por null
    #     para que no distorsione promedios, y se agrega la bandera renovada (0/1).
    df = (df.withColumn("renovada", (F.col("yr_renovated") > 0).cast("int"))
            .withColumn("yr_renovated",
                        F.when(F.col("yr_renovated") == 0, None)
                         .otherwise(F.col("yr_renovated"))))

    # 2.8 Precios atípicos según el criterio IQR (rango intercuartílico).
    #     Se marcan con outlier_precio = 1 pero NO se eliminan, porque son
    #     mansiones reales y forman parte del mercado.
    q1, q3 = df.approxQuantile("price", [0.25, 0.75], 0.001)
    iqr = q3 - q1
    limite_inferior, limite_superior = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    df = df.withColumn(
        "outlier_precio",
        ((F.col("price") < limite_inferior) | (F.col("price") > limite_superior)).cast("int"))

    return df


def agregar_columnas_derivadas(df: DataFrame) -> DataFrame:
    """Crea las variables de análisis que usan Power BI y el ANOVA."""

    # Variables de fecha, antigüedad y superficie en metros cuadrados
    df = (df.withColumn("anio_venta", F.year("date"))
            .withColumn("mes_venta", F.month("date"))
            .withColumn("antiguedad", F.year("date") - F.col("yr_built"))
            .withColumn("tiene_sotano", (F.col("sqft_basement") > 0).cast("int"))
            .withColumn("sqft_living_m2", F.round(F.col("sqft_living") * PIE2_A_M2, 2))
            .withColumn("sqft_lot_m2", F.round(F.col("sqft_lot") * PIE2_A_M2, 2))
            # Requerimiento 1: precio por metro cuadrado habitable
            .withColumn("precio_m2",
                        F.round(F.col("price") / (F.col("sqft_living") * PIE2_A_M2), 2)))

    # Requerimiento 6: década de construcción, por ejemplo 1957 -> "1950s"
    df = df.withColumn(
        "decada_construccion",
        F.concat((F.floor(F.col("yr_built") / 10) * 10).cast("int").cast("string"), F.lit("s")))

    # Requerimiento 9: etiqueta legible para waterfront (frente al agua)
    df = df.withColumn("frente_agua",
                       F.when(F.col("waterfront") == 1, "Sí").otherwise("No"))

    # Requerimiento 10: segmentación por rangos de precio.
    # Las etiquetas llevan un número adelante para que se ordenen bien en Power BI.
    df = df.withColumn(
        "rango_precio",
        F.when(F.col("price") < 300_000, "1. Económico (<300K)")
         .when(F.col("price") < 500_000, "2. Medio (300K-500K)")
         .when(F.col("price") < 750_000, "3. Medio-alto (500K-750K)")
         .when(F.col("price") < 1_000_000, "4. Alto (750K-1M)")
         .otherwise("5. Lujo (>1M)"))

    # Requerimiento 2: el dataset no trae un tipo de vivienda, así que se
    # deriva a partir de la cantidad de plantas (floors) y de si tiene sótano.
    # floors toma los valores 1, 1.5, 2, 2.5, 3 y 3.5.
    df = df.withColumn(
        "tipo_vivienda",
        F.when((F.col("floors") < 1.5) & (F.col("tiene_sotano") == 0), "Una planta")
         .when(F.col("floors") < 1.5, "Una planta con sótano")
         .when(F.col("floors") <= 2.0, "Dos plantas")
         .otherwise("Tres o más plantas"))

    # Categoría de calidad según grade (escala de 1 a 13 del condado)
    df = df.withColumn(
        "categoria_calidad",
        F.when(F.col("grade") <= 6, "Económica")
         .when(F.col("grade") <= 8, "Estándar")
         .when(F.col("grade") <= 10, "Alta")
         .otherwise("Lujo"))

    # Requerimiento 5: grupos de baños. bathrooms usa fracciones de 0.25
    # (por ejemplo, 0.75 = baño con ducha pero sin bañera).
    df = df.withColumn(
        "grupo_banios",
        F.when(F.col("bathrooms") <= 1, "1 o menos")
         .when(F.col("bathrooms") <= 2, "1.25-2")
         .when(F.col("bathrooms") <= 3, "2.25-3")
         .when(F.col("bathrooms") <= 4, "3.25-4")
         .otherwise("Más de 4"))

    # Requerimiento 5: grupos de habitaciones ("1" a "5" y "6 o más")
    df = df.withColumn(
        "grupo_habitaciones",
        F.when(F.col("bedrooms") >= 6, "6 o más")
         .otherwise(F.col("bedrooms").cast("string")))

    return df


def enriquecer_con_barrios(df: DataFrame, barrios: DataFrame) -> DataFrame:
    """Agrega ciudad y barrio a cada venta cruzando por zipcode (requerimiento 4)."""
    # Se usa un left join para no perder ventas si algún zipcode no está en la tabla.
    df = df.join(barrios, on="zipcode", how="left")

    # Control de calidad: se avisa si quedó alguna venta sin barrio asignado.
    sin_barrio = df.filter(F.col("barrio").isNull())
    if sin_barrio.count() > 0:
        codigos = [fila.zipcode for fila in sin_barrio.select("zipcode").distinct().collect()]
        print(f"ATENCIÓN: {sin_barrio.count()} ventas sin barrio. Zipcodes faltantes: {codigos}")
    else:
        print("Todos los zipcodes tienen barrio asignado.")
    return df


def transformar(ventas: DataFrame, barrios: DataFrame) -> tuple[DataFrame, list]:
    """Ejecuta limpieza, columnas derivadas y enriquecimiento.

    Devuelve el DataFrame final y una lista de (etapa, cantidad de filas)
    para poder mostrar cómo cambia el volumen de datos en cada paso.
    """
    conteos = []
    df = limpiar(ventas, conteos)
    df = agregar_columnas_derivadas(df)
    df = enriquecer_con_barrios(df, barrios)
    conteos.append(("Enriquecido con barrios", df.count()))
    return df, conteos


# ===========================================================================
# 3. MODELO PREDICTIVO (requerimiento 7)
# ===========================================================================
# Variables explicativas del modelo. Los nombres coinciden con las columnas
# de fact_ventas, así el simulador de Power BI puede buscar cada coeficiente.
VARIABLES_MODELO = ["sqft_living_m2", "bathrooms", "bedrooms", "grade",
                    "waterfront", "view", "condition", "antiguedad", "lat"]
SEMILLA = 42  # semilla fija: el split y el bosque aleatorio dan siempre el mismo resultado


def evaluar(predicciones: DataFrame, nombre_modelo: str) -> tuple:
    """Calcula R², RMSE y MAE comparando price (real) con prediction (predicho)."""
    metricas = {}
    for metrica in ["r2", "rmse", "mae"]:
        evaluador = RegressionEvaluator(labelCol="price", predictionCol="prediction",
                                        metricName=metrica)
        metricas[metrica] = round(evaluador.evaluate(predicciones), 4)
    return (nombre_modelo, metricas["r2"], metricas["rmse"], metricas["mae"])


def entrenar_modelo(df: DataFrame) -> dict:
    """Entrena una regresión lineal (y un Random Forest para comparar).

    Devuelve las tablas predicciones, coeficientes_modelo y metricas_modelo.
    """
    spark = df.sparkSession

    # 3.1 MLlib necesita todas las variables juntas en una sola columna de tipo
    #     vector ("features"). VectorAssembler arma ese vector fila por fila.
    #     No se escalan las variables a propósito: así cada coeficiente queda en
    #     su unidad original (dólares por m², por baño, etc.), que es lo que
    #     necesita el simulador de Power BI y es más fácil de interpretar.
    ensamblador = VectorAssembler(inputCols=VARIABLES_MODELO, outputCol="features")
    datos = ensamblador.transform(df).select("id", "price", "features")

    # 3.2 Separación en entrenamiento (80 %) y prueba (20 %). El modelo aprende
    #     con el 80 % y se evalúa con el 20 % restante, que nunca vio, para
    #     medir qué tan bien predice casas nuevas.
    entrenamiento, prueba = datos.randomSplit([0.8, 0.2], seed=SEMILLA)
    entrenamiento, prueba = entrenamiento.cache(), prueba.cache()
    print(f"[Modelo] Filas de entrenamiento: {entrenamiento.count()} | "
          f"de prueba: {prueba.count()}")

    # 3.3 Regresión lineal: precio = intercepto + suma(coeficiente * variable)
    regresion = LinearRegression(featuresCol="features", labelCol="price")
    modelo_lineal = regresion.fit(entrenamiento)
    pred_lineal = modelo_lineal.transform(prueba)

    # 3.4 Random Forest: muchos árboles de decisión que "votan" el precio.
    #     Capta relaciones no lineales (por ejemplo, que la ubicación pese
    #     distinto según la zona), pero no da coeficientes simples. Se usa
    #     solo como punto de comparación.
    bosque = RandomForestRegressor(featuresCol="features", labelCol="price",
                                   numTrees=100, maxDepth=10, seed=SEMILLA)
    modelo_bosque = bosque.fit(entrenamiento)
    pred_bosque = modelo_bosque.transform(prueba)

    # 3.5 Métricas sobre el set de prueba
    metricas = spark.createDataFrame(
        [evaluar(pred_lineal, "Regresión lineal"),
         evaluar(pred_bosque, "Random Forest")],
        ["modelo", "r2", "rmse", "mae"])

    # 3.6 Coeficientes de la regresión lineal, más el intercepto
    filas_coef = [("intercepto", round(float(modelo_lineal.intercept), 4))]
    filas_coef += [(variable, round(float(coef), 4))
                   for variable, coef in zip(VARIABLES_MODELO, modelo_lineal.coefficients)]
    coeficientes = spark.createDataFrame(filas_coef, ["variable", "coeficiente"])

    # Importancia de cada variable en el Random Forest (solo se muestra en consola)
    importancias = sorted(zip(VARIABLES_MODELO, modelo_bosque.featureImportances.toArray()),
                          key=lambda par: -par[1])
    print("[Modelo] Importancia de variables (Random Forest): " +
          ", ".join(f"{v} {i:.1%}" for v, i in importancias))

    # 3.7 Predicciones de la regresión lineal sobre el set de prueba.
    #     error = real - predicho: positivo si el modelo se quedó corto.
    predicciones = (pred_lineal
                    .withColumn("precio_predicho", F.round("prediction", 2))
                    .withColumn("error", F.round(F.col("price") - F.col("prediction"), 2))
                    .select("id", "price", "precio_predicho", "error")
                    .orderBy("id"))

    return {"predicciones": predicciones,
            "coeficientes_modelo": coeficientes,
            "metricas_modelo": metricas}


# ===========================================================================
# 4. CARGA
# ===========================================================================
# Columnas de la tabla de hechos, en el orden en que se exportan
COLUMNAS_FACT_VENTAS = [
    "id", "date", "zipcode", "id_vivienda", "price", "precio_m2", "bedrooms",
    "bathrooms", "sqft_living_m2", "sqft_lot_m2", "waterfront", "frente_agua",
    "view", "condition", "grade", "yr_built", "decada_construccion",
    "yr_renovated", "renovada", "antiguedad", "lat", "long", "rango_precio",
    "grupo_banios", "grupo_habitaciones", "tipo_vivienda", "categoria_calidad",
    "n_ventas", "outlier_precio",
]

# Nombres en español para la dimensión de fechas.
# Spark solo da nombres en inglés, por eso se traducen con un diccionario.
NOMBRES_MES = {1: "Enero", 2: "Febrero", 3: "Marzo", 4: "Abril", 5: "Mayo",
               6: "Junio", 7: "Julio", 8: "Agosto", 9: "Septiembre",
               10: "Octubre", 11: "Noviembre", 12: "Diciembre"}
# dayofweek() de Spark numera 1 = domingo, 2 = lunes, ..., 7 = sábado
NOMBRES_DIA = {1: "Domingo", 2: "Lunes", 3: "Martes", 4: "Miércoles",
               5: "Jueves", 6: "Viernes", 7: "Sábado"}


def traducir(columna, diccionario: dict):
    """Convierte un número en texto usando un diccionario (por ejemplo, 1 -> "Enero")."""
    pares = []
    for clave, valor in diccionario.items():
        pares += [F.lit(clave), F.lit(valor)]
    return F.create_map(*pares)[columna]


def construir_dim_ubicacion(df: DataFrame) -> DataFrame:
    """Una fila por zipcode, con su ciudad, barrio y coordenadas promedio."""
    return (df.groupBy("zipcode", "ciudad", "barrio")
              .agg(F.round(F.avg("lat"), 6).alias("lat_promedio"),
                   F.round(F.avg("long"), 6).alias("long_promedio"),
                   F.count("*").alias("cantidad_ventas"))
              .orderBy("zipcode"))


def construir_dim_fecha(df: DataFrame) -> DataFrame:
    """Calendario completo: un día por fila entre la primera y la última venta.

    Se generan todos los días (aunque no haya ventas) porque Power BI necesita
    una tabla de fechas continua para marcarla como tabla de fechas.
    """
    limites = df.agg(F.min("date").alias("desde"), F.max("date").alias("hasta"))
    calendario = limites.select(
        F.explode(F.sequence("desde", "hasta", F.expr("interval 1 day"))).alias("fecha"))
    return (calendario
            .withColumn("anio", F.year("fecha"))
            .withColumn("mes", F.month("fecha"))
            .withColumn("nombre_mes", traducir(F.month("fecha"), NOMBRES_MES))
            .withColumn("trimestre", F.quarter("fecha"))
            .withColumn("dia_semana", traducir(F.dayofweek("fecha"), NOMBRES_DIA))
            .orderBy("fecha"))


def construir_dim_vivienda(df: DataFrame) -> DataFrame:
    """Una fila por cada combinación distinta de (floors, tiene_sotano, grade).

    tipo_vivienda y categoria_calidad dependen solo de esas tres columnas,
    así que cada combinación tiene una única tipología y una única calidad.
    Se le asigna una clave entera (id_vivienda) para relacionarla con los hechos.
    """
    combinaciones = (df.select("floors", "tiene_sotano", "grade",
                               "tipo_vivienda", "categoria_calidad")
                       .distinct())
    # row_number sobre un orden fijo da claves estables entre ejecuciones (1, 2, 3, ...).
    # La ventana no tiene partición, pero la tabla es chica, así que no hay problema.
    orden = Window.orderBy("floors", "tiene_sotano", "grade")
    return (combinaciones
            .withColumn("id_vivienda", F.row_number().over(orden))
            .select("id_vivienda", "floors", "tiene_sotano", "grade",
                    "tipo_vivienda", "categoria_calidad")
            .orderBy("id_vivienda"))


def construir_fact_ventas(df: DataFrame, dim_vivienda: DataFrame) -> DataFrame:
    """Tabla de hechos: una fila por venta, con medidas y claves a las dimensiones."""
    claves = dim_vivienda.select("floors", "tiene_sotano", "grade", "id_vivienda")
    return (df.join(claves, on=["floors", "tiene_sotano", "grade"], how="left")
              .select(*COLUMNAS_FACT_VENTAS)
              .orderBy("date", "id"))


def calcular_correlaciones(df: DataFrame) -> DataFrame:
    """Correlación de Pearson de cada variable numérica con el precio (requerimiento 8)."""
    spark = df.sparkSession
    numericas = [campo.name for campo in df.schema.fields
                 if isinstance(campo.dataType, NumericType) and campo.name != "price"]
    filas = []
    for columna in numericas:
        # Se descartan los nulos de cada par (por ejemplo, yr_renovated es null
        # en las casas nunca renovadas) para que no afecten el cálculo.
        par = df.select(columna, "price").dropna()
        correlacion = par.stat.corr(columna, "price")
        filas.append((columna, round(float(correlacion), 4)))
    return (spark.createDataFrame(filas, ["variable", "correlacion_con_precio"])
                 .orderBy(F.col("correlacion_con_precio").desc()))


def guardar_tabla(tabla: DataFrame, nombre: str) -> str:
    """Guarda una tabla como un único archivo salida/<nombre>.csv y devuelve el método usado.

    Primero intenta escribir con Spark. Spark siempre escribe una carpeta con
    archivos "part-*", así que se junta todo en una sola partición (coalesce(1))
    y después se mueve ese archivo a salida/<nombre>.csv.
    En Windows sin HADOOP_HOME/winutils.exe, Spark no puede escribir en disco:
    en ese caso se convierte la tabla a pandas y se guarda con to_csv().
    """
    ruta_csv = os.path.join(CARPETA_SALIDA, f"{nombre}.csv")
    carpeta_temporal = os.path.join(CARPETA_SALIDA, f"_tmp_{nombre}")
    try:
        (tabla.coalesce(1).write.mode("overwrite")
              .option("header", True)
              .option("sep", ",")
              .option("encoding", "UTF-8")
              .csv(carpeta_temporal))
        archivo_part = glob.glob(os.path.join(carpeta_temporal, "part-*.csv"))[0]
        shutil.move(archivo_part, ruta_csv)
        metodo = "Spark"
    except Exception:
        guardar_con_pandas(tabla, ruta_csv)
        metodo = "pandas (Spark no pudo escribir)"
    finally:
        shutil.rmtree(carpeta_temporal, ignore_errors=True)

    # Copia opcional en Parquet (formato columnar, más liviano y con tipos).
    # Tiene la misma limitación en Windows, así que si falla solo se avisa.
    carpeta_parquet = os.path.join(CARPETA_SALIDA, "parquet")
    try:
        tabla.write.mode("overwrite").parquet(os.path.join(carpeta_parquet, nombre))
        metodo += " + parquet"
    except Exception:
        # Se borra lo que haya quedado a medio escribir y, si la carpeta
        # salida/parquet/ quedó vacía, también se borra.
        shutil.rmtree(os.path.join(carpeta_parquet, nombre), ignore_errors=True)
        if os.path.isdir(carpeta_parquet) and not os.listdir(carpeta_parquet):
            os.rmdir(carpeta_parquet)
    return metodo


def guardar_con_pandas(tabla: DataFrame, ruta_csv: str):
    """Alternativa de escritura: pasa la tabla a pandas y la guarda como CSV."""
    pdf = tabla.toPandas()
    # Al pasar a pandas, una columna entera que tiene nulos se convierte en
    # decimal (por ejemplo, yr_renovated quedaría 1991.0). Se usa el tipo
    # "Int64" de pandas, que admite nulos sin perder el formato entero.
    for campo in tabla.schema.fields:
        if isinstance(campo.dataType, (IntegerType, LongType)):
            pdf[campo.name] = pdf[campo.name].astype("Int64")
    # index=False: no se exporta el índice de pandas.
    # Separador coma y punto decimal son los valores por defecto de to_csv.
    pdf.to_csv(ruta_csv, index=False, sep=",", decimal=".", encoding="utf-8")


def cargar(df: DataFrame) -> dict:
    """Construye el modelo estrella y lo escribe en salida/. Devuelve las tablas."""
    os.makedirs(CARPETA_SALIDA, exist_ok=True)

    dim_vivienda = construir_dim_vivienda(df)
    tablas = {
        "dim_ubicacion": construir_dim_ubicacion(df),
        "dim_fecha": construir_dim_fecha(df),
        "dim_vivienda": dim_vivienda,
        "fact_ventas": construir_fact_ventas(df, dim_vivienda),
        "correlaciones": calcular_correlaciones(df),
    }
    for nombre, tabla in tablas.items():
        metodo = guardar_tabla(tabla, nombre)
        print(f"[Carga] {nombre}.csv: {tabla.count()} filas (guardado con {metodo})")

    if not os.path.isdir(os.path.join(CARPETA_SALIDA, "parquet")):
        print("[Carga] Parquet no disponible en este equipo (falta winutils): solo se generaron CSV.")
    return tablas


def verificar_integridad(tablas: dict):
    """Comprueba que cada clave de fact_ventas exista en su dimensión.

    Se usa un left_anti join: devuelve las filas de los hechos que NO tienen
    pareja en la dimensión. Si el resultado está vacío, no hay claves huérfanas.
    """
    hechos = tablas["fact_ventas"]
    relaciones = [
        ("zipcode", tablas["dim_ubicacion"], "zipcode"),
        ("date", tablas["dim_fecha"], "fecha"),
        ("id_vivienda", tablas["dim_vivienda"], "id_vivienda"),
    ]
    todo_bien = True
    for clave_hecho, dimension, clave_dim in relaciones:
        huerfanas = hechos.join(dimension,
                                hechos[clave_hecho] == dimension[clave_dim],
                                how="left_anti").count()
        nulas = hechos.filter(F.col(clave_hecho).isNull()).count()
        estado = "OK" if huerfanas == 0 and nulas == 0 else "ERROR"
        todo_bien &= estado == "OK"
        print(f"[Integridad] fact_ventas.{clave_hecho} -> {clave_dim}: "
              f"{huerfanas} huérfanas, {nulas} nulas ({estado})")
    # Las claves de las dimensiones tienen que ser únicas (relación muchos a uno)
    for nombre, clave in [("dim_ubicacion", "zipcode"), ("dim_fecha", "fecha"),
                          ("dim_vivienda", "id_vivienda")]:
        tabla = tablas[nombre]
        repetidas = tabla.count() - tabla.select(clave).distinct().count()
        todo_bien &= repetidas == 0
        print(f"[Integridad] {nombre}.{clave}: {repetidas} claves repetidas")
    print("[Integridad] Modelo estrella consistente." if todo_bien
          else "[Integridad] ATENCIÓN: hay problemas en el modelo.")


# ===========================================================================
# Programa principal
# ===========================================================================
def main():
    spark = crear_sesion()
    try:
        # Extracción
        ventas, barrios = extraer(spark)
        print(f"[Extracción] Filas originales de ventas: {ventas.count()}")
        print(f"[Extracción] Zipcodes en la tabla de barrios: {barrios.count()}")

        # Transformación
        df, conteos = transformar(ventas, barrios)
        for etapa, cantidad in conteos:
            print(f"[Transformación] {etapa}: {cantidad}")
        print(f"[Transformación] Precios atípicos marcados (IQR): "
              f"{df.filter(F.col('outlier_precio') == 1).count()}")

        # Se guarda en memoria el resultado de la transformación, porque la
        # carga lo recorre varias veces (una por tabla) y así no se recalcula.
        df = df.cache()

        # Carga y verificación del modelo estrella
        tablas = cargar(df)
        verificar_integridad(tablas)

        # Modelo predictivo: se entrena y se guardan sus tablas en salida/
        tablas_modelo = entrenar_modelo(df)
        for nombre, tabla in tablas_modelo.items():
            metodo = guardar_tabla(tabla, nombre)
            print(f"[Carga] {nombre}.csv: {tabla.count()} filas (guardado con {metodo})")
        print("[Modelo] Métricas en el set de prueba:")
        tablas_modelo["metricas_modelo"].show(truncate=False)
        print("[Modelo] Coeficientes de la regresión lineal:")
        tablas_modelo["coeficientes_modelo"].show(truncate=False)
    finally:
        spark.stop()


if __name__ == "__main__":
    main()
