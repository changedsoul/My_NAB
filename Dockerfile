FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    NAB_DB_PATH=/data/nab.db \
    PORT=8000

WORKDIR /app

COPY requirements.txt requirements-secure.txt ./
# The encryption add-on (sqlcipher3) ships ready-made for x86 NAS/servers. Where it doesn't (ARM: Raspberry Pi,
# some Synology models) try building it from source. If that fails too, the app still works: Settings, Security
# then says encryption isn't available on this server.
RUN pip install --no-cache-dir -r requirements.txt \
 && ( pip install --no-cache-dir -r requirements-secure.txt \
      || ( apt-get update && apt-get install -y --no-install-recommends gcc libsqlcipher-dev \
           && pip install --no-cache-dir sqlcipher3 ; rm -rf /var/lib/apt/lists/* ) \
      || echo "WARNING: sqlcipher3 could not be installed; budget encryption will not be available" )

COPY . .

# SQLite database lives on a mounted volume so it survives container rebuilds.
VOLUME ["/data"]
EXPOSE 8000

# ONE worker with several threads: an encrypted budget's key is held in this process's memory only, so every
# request has to reach the same process. (Plenty for a personal app; threads cover the SQLite waits.)
CMD ["gunicorn", "-b", "0.0.0.0:8000", "-w", "1", "--threads", "8", \
     "--timeout", "120", "app:app"]
