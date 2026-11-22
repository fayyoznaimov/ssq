FROM python:3.11-slim

WORKDIR /app

# ffmpeg converts voice messages to mp3 (pydub)
RUN apt-get update &&     apt-get install -y --no-install-recommends ffmpeg &&     apt-get clean &&     rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY . /app

CMD ["python", "app.py"]
