FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir ortools openpyxl pandas
COPY . .
CMD ["python", "optimize.py"]
