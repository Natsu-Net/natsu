# natsu v2 benchmark results

Regenerate with `bun run bench` (add `--save` to rewrite this file).

```
natsu v2 benchmark — Bun 1.3.11
3s per scenario, 1s warm-up, in-process load

## 1 connection

scenario                         req/s      mean       p50       p95       p99       max
                                              ms        ms        ms        ms        ms
--------------------------------------------------------------------------------------
bare   plain text                13370      0.07      0.07      0.09      0.21      2.81
natsu  plain text                13279      0.08      0.07      0.09      0.18      1.56
  overhead                        0.7%      +1µs                                        

bare   static file (8 KB)        12711      0.08      0.06      0.09      0.59      3.63
natsu  static file (8 KB)        10034      0.10      0.08      0.12      0.67      2.23
  overhead                       21.1%     +21µs                                        

bare   rendered template         13657      0.07      0.07      0.09      0.15      1.63
natsu  rendered template         13011      0.08      0.07      0.10      0.20      1.76
  overhead                        4.7%      +4µs                                        


## 32 connections

scenario                         req/s      mean       p50       p95       p99       max
                                              ms        ms        ms        ms        ms
--------------------------------------------------------------------------------------
bare   plain text                62372      0.51      0.46      0.81      1.56      3.60
natsu  plain text                44333      0.72      0.73      1.40      2.07      5.35
  overhead                       28.9%    +209µs                                        

bare   static file (8 KB)        30884      1.04      0.94      2.33      2.84      6.32
natsu  static file (8 KB)        21302      1.50      1.38      3.08      3.73      5.70
  overhead                       31.0%    +466µs                                        

bare   rendered template         49566      0.65      0.62      1.25      2.06      4.12
natsu  rendered template         39960      0.80      0.77      1.59      2.15      4.64
  overhead                       19.4%    +155µs                                        

```

Recorded 2026-09-20T02:31:53.960Z on Bun 1.3.11, linux/x64.

## Reading this

The load generator runs in the same process as the servers, so absolute
throughput is lower than a dedicated client would report. Both targets pay
that cost equally; the overhead column is the number to watch.

At one connection the overhead is natsu's serial cost per request. At 32 the
client and both servers contend for one event loop, so the figure is a
pessimistic bound rather than a measurement of the framework alone.

The baseline is the least Bun code that answers the same request. For the
static scenario that means natsu is additionally doing path containment,
a stat, ETag/Last-Modified generation, conditional-request handling and
range parsing, none of which the baseline does.
