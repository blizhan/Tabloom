import test from "node:test";
import assert from "node:assert/strict";
import { preparePredictionInput } from "../../src/workbench/prediction-input";
import { decodeRegressionQuantiles } from "../../src/model/tabpfn35/decode";

test("selected target is excluded from features; SQL output length and order are preserved beyond preview size", () => {
  const rows = Array.from({length:250}, (_,i) => ({ x: i, price: 10 + i, demand: 100 - i }));
  const training = {columns:["x","price","demand"], rows};
  const prediction = {columns:training.columns, rows:[rows[8],rows[3],{x:1,price:NaN,demand:1}]};
  const result = preparePredictionInput(training,prediction,"price",["x","demand"]);
  assert.equal(result.training.rowCount,250);
  assert.equal(result.prediction.rowCount,3);
  assert.deepEqual([...result.prediction.columns[0]],[8,3,1]);
  assert.deepEqual(result.truth,[18,13,null]);
  assert.deepEqual(result.training.columnNames,["x","demand"]);
  assert.throws(()=>preparePredictionInput(training,prediction,"price",["price"]),/目标列/);
  assert.throws(()=>preparePredictionInput(training,{columns:["x"],rows:[{x:1}]},"price",["demand"]),/必须包含/);
});

test("quantiles interpolate the inverse CDF and inverse target transform", () => {
  const logits = new Float32Array(5000).fill(-Infinity); logits[2000]=0;
  const borders = Array.from({length:5001},(_,i)=>i);
  const result = decodeRegressionQuantiles(logits,[1,5000],{borders,targetMean:10,targetScale:2});
  assert.equal(result.q25[0],4010.5); assert.equal(result.q75[0],4011.5);
  const translated = decodeRegressionQuantiles(logits,[1,5000],{borders,targetMean:10,targetScale:2,translateProbabilities:true});
  assert.deepEqual(translated,result);
});

test("quantiles match official icdf's linear outer buckets, distinct from half-normal means", () => {
  const borders=Array.from({length:5001},(_,i)=>i);
  const left=new Float32Array(5000).fill(-Infinity); left[0]=0;
  const right=new Float32Array(5000).fill(-Infinity); right[4999]=0;
  const state={borders,targetMean:0,targetScale:1};
  const a=decodeRegressionQuantiles(left,[1,5000],state), b=decodeRegressionQuantiles(right,[1,5000],state);
  assert.equal(a.q25[0],0.25); assert.equal(a.q75[0],0.75);
  assert.equal(b.q25[0],4999.25); assert.equal(b.q75[0],4999.75);
  assert.throws(()=>decodeRegressionQuantiles(new Float32Array(5000).fill(-Infinity),[1,5000],state));
});
