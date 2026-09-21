SELECT business_key, COUNT(*) AS row_count, AVG(demand_mwh) AS mean_demand_mwh FROM train GROUP BY business_key ORDER BY business_key;
