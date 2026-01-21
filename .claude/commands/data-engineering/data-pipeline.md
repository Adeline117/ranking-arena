# Data Pipeline Architecture

Design and implement scalable data pipelines covering ETL/ELT, Lambda, Kappa, and Lakehouse architectures.

## Requirements

Build pipeline for: **$ARGUMENTS**

## Architecture Patterns

### Batch Processing (ETL/ELT)
- Scheduled data extraction
- Transformation with dbt
- Loading to data warehouse

### Stream Processing (Kappa)
- Real-time event streaming
- Kafka/Kinesis ingestion
- Continuous processing

### Lambda Architecture
- Batch layer for accuracy
- Speed layer for low latency
- Serving layer for queries

### Lakehouse
- Delta Lake / Iceberg
- ACID transactions
- Schema evolution

## Ingestion Layer

```python
class IncrementalLoader:
    def __init__(self, source, target, watermark_column):
        self.source = source
        self.target = target
        self.watermark = watermark_column

    async def extract_incremental(self):
        last_watermark = await self.get_last_watermark()
        query = f"""
            SELECT * FROM {self.source}
            WHERE {self.watermark} > '{last_watermark}'
        """
        return await self.execute(query)
```

## Orchestration (Airflow)

```python
from airflow import DAG
from airflow.operators.python import PythonOperator
from datetime import datetime, timedelta

default_args = {
    'owner': 'data-team',
    'retries': 3,
    'retry_delay': timedelta(minutes=5),
}

with DAG(
    'data_pipeline',
    default_args=default_args,
    schedule_interval='@hourly',
    start_date=datetime(2024, 1, 1),
) as dag:

    extract = PythonOperator(
        task_id='extract',
        python_callable=extract_data,
    )

    transform = PythonOperator(
        task_id='transform',
        python_callable=transform_data,
    )

    load = PythonOperator(
        task_id='load',
        python_callable=load_data,
    )

    extract >> transform >> load
```

## Transformation (dbt)

```sql
-- models/staging/stg_orders.sql
{{ config(materialized='incremental', unique_key='order_id') }}

SELECT
    order_id,
    customer_id,
    order_date,
    total_amount,
    {{ dbt_utils.surrogate_key(['order_id']) }} as order_key
FROM {{ source('raw', 'orders') }}
{% if is_incremental() %}
WHERE updated_at > (SELECT MAX(updated_at) FROM {{ this }})
{% endif %}
```

## Data Quality (Great Expectations)

```python
import great_expectations as gx

context = gx.get_context()

expectation_suite = context.add_expectation_suite("orders_suite")

# Add expectations
expectation_suite.add_expectation(
    gx.expectations.ExpectColumnValuesToNotBeNull(column="order_id")
)
expectation_suite.add_expectation(
    gx.expectations.ExpectColumnValuesToBeBetween(
        column="total_amount", min_value=0
    )
)
```

## Storage (Delta Lake)

```python
from delta import DeltaTable

# Write with ACID transactions
df.write.format("delta") \
    .mode("merge") \
    .option("mergeSchema", "true") \
    .save("/data/orders")

# Time travel
df = spark.read.format("delta") \
    .option("versionAsOf", 5) \
    .load("/data/orders")

# Optimize
DeltaTable.forPath(spark, "/data/orders").optimize().executeZOrderBy("date")
```

## Monitoring

- Pipeline execution metrics (Prometheus)
- Data quality dashboards (Grafana)
- Alerting on failures (PagerDuty)

## Output

1. Architecture diagram
2. Pipeline code
3. Orchestration DAGs
4. dbt models
5. Data quality tests
6. Monitoring config
