OR-Tools optimizer scaffold

This folder contains a Python script that uses OR-Tools CP-SAT to try to optimize seating.
It is optional. To enable:
1. Install Python 3.10+ and pip.
2. pip install ortools openpyxl pandas
3. Run the optimizer as:
   python optimize.py /path/to/students.json /path/to/halls.json

The script provided is a best-effort scaffold and may need tuning for large inputs.
