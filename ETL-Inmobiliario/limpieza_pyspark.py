"""
Limpieza del dataset kc_house_data.csv (ventas de casas en King County, WA, 2014-2015) con PySpark.

Uso:
    python limpieza_pyspark.py
Genera: kc_house_clean/ (parquet)
"""
from pyspark.sql import SparkSession, functions as F, Window
from pyspark.sql.types import (StructType, StructField, StringType, DoubleType,
                               IntegerType)

spark = (SparkSession.builder
         .appName("LimpiezaKCHouse")
         .master("local[*]")
         .getOrCreate())
spark.sparkContext.setLogLevel("ERROR")

# 1) Esquema explícito: evita que inferSchema convierta id/zipcode a número
#    (se pierden ceros a la izquierda, p. ej. id "0627300145") y deja date como texto para parsearlo.
schema = StructType([
    StructField("id", StringType()), StructField("date", StringType()),
    StructField("price", DoubleType()), StructField("bedrooms", IntegerType()),
    StructField("bathrooms", DoubleType()), StructField("sqft_living", IntegerType()),
    StructField("sqft_lot", IntegerType()), StructField("floors", DoubleType()),
    StructField("waterfront", IntegerType()), StructField("view", IntegerType()),
    StructField("condition", IntegerType()), StructField("grade", IntegerType()),
    StructField("sqft_above", IntegerType()), StructField("sqft_basement", IntegerType()),
    StructField("yr_built", IntegerType()), StructField("yr_renovated", IntegerType()),
    StructField("zipcode", StringType()), StructField("lat", DoubleType()),
    StructField("long", DoubleType()), StructField("sqft_living15", IntegerType()),
    StructField("sqft_lot15", IntegerType()),
])

df = spark.read.csv("kc_house_data.csv", header=True, schema=schema)
print("Filas originales:", df.count())

# 2) Nulos y duplicados exactos (el dataset no tiene, pero se verifica)
df = df.dropna().dropDuplicates()

# 3) Fecha: "20141013T000000" -> date
df = df.withColumn("date", F.to_date(F.substring("date", 1, 8), "yyyyMMdd"))

# 4) Propiedades vendidas más de una vez (176 ids, 177 filas extra):
#    se conserva la venta más reciente para tener una fila por propiedad.
w = Window.partitionBy("id").orderBy(F.col("date").desc())
df = (df.withColumn("n_ventas", F.count("*").over(Window.partitionBy("id")))
        .withColumn("rn", F.row_number().over(w))
        .filter("rn = 1").drop("rn"))

# 5) Valores imposibles o errores de carga
df = df.withColumn("bedrooms",                      # 33 dormitorios en 1620 sqft: error de tipeo de 3
                   F.when((F.col("bedrooms") == 33) & (F.col("sqft_living") < 2000), 3)
                    .otherwise(F.col("bedrooms")))
df = df.filter((F.col("bedrooms") > 0) & (F.col("bathrooms") > 0))  # casas sin dormitorios o baños
df = df.filter(F.col("sqft_living") >= 300)       # superficie habitable irreal

# 6) Coherencia de años: casas vendidas antes de terminarse (yr_built > año de venta)
df = df.filter(F.col("yr_built") <= F.year("date"))

# 7) yr_renovated = 0 significa "nunca renovada": se pasa a null + flag
df = (df.withColumn("renovada", (F.col("yr_renovated") > 0).cast("int"))
        .withColumn("yr_renovated",
                    F.when(F.col("yr_renovated") == 0, None).otherwise(F.col("yr_renovated"))))

# 8) Validaciones de consistencia (solo se reportan)
print("sqft_above + sqft_basement != sqft_living:",
      df.filter(F.col("sqft_above") + F.col("sqft_basement") != F.col("sqft_living")).count())

# 9) Outliers de precio por IQR: se marcan en vez de borrarlos (las mansiones son reales)
q1, q3 = df.approxQuantile("price", [0.25, 0.75], 0.001)
iqr = q3 - q1
df = df.withColumn("outlier_precio",
                   ((F.col("price") < q1 - 1.5 * iqr) | (F.col("price") > q3 + 1.5 * iqr)).cast("int"))

# 10) Columnas derivadas útiles para el análisis del mercado
df = (df.withColumn("anio_venta", F.year("date"))
        .withColumn("mes_venta", F.month("date"))
        .withColumn("antiguedad", F.year("date") - F.col("yr_built"))
        .withColumn("precio_m2", F.round(F.col("price") / (F.col("sqft_living") * 0.092903), 2))
        .withColumn("tiene_sotano", (F.col("sqft_basement") > 0).cast("int"))
        .withColumn("sqft_living_m2", F.round(F.col("sqft_living") * 0.092903, 2))
        .withColumn("sqft_lot_m2", F.round(F.col("sqft_lot") * 0.092903, 2)))

print("Filas finales:", df.count())
print("Outliers de precio marcados:", df.filter("outlier_precio = 1").count())
df.printSchema()
df.select("id", "date", "price", "bedrooms", "bathrooms", "precio_m2", "antiguedad",
          "renovada", "n_ventas").show(5)

try:
    df.write.mode("overwrite").parquet("kc_house_clean")
    print("Guardado en kc_house_clean/ (parquet)")
except Exception:
    # En Windows sin HADOOP_HOME/winutils.exe Spark no puede escribir a disco:
    # como el dataset es chico, se guarda vía pandas.
    df.toPandas().to_csv("kc_house_clean.csv", index=False)
    print("Sin winutils: guardado en kc_house_clean.csv")
spark.stop()
