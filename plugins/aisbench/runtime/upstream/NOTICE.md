# AISBench workload wrapper

Source: https://github.com/rayn-zzz/aisbench_auto_tools_prefix

Revision: ac06bd619726663ac8c7b0c84c9b3cdbb041b062

License: MIT (see LICENSE).

Local changes to aisbench_test.py: execute AISBench using an argument array, tee
output without a shell pipeline so failures propagate, and generate API config
using Python repr without printing credentials. save_file.py uses None for
unmeasured metrics instead of numerical sentinel values. Dataset generation and prefix
warmup behavior remain the upstream implementation. Files use LF line endings.
