# How to run the ELBE-UI backend

## Inside Docker (recommended)

The ELBE UI is automatically started when the elbe-dev container boots.
Access it at: http://localhost:8080

Rebuild the container after changes:
  cd /path/to/elbe/docker
  docker compose build && docker compose up -d

## Standalone (development)

1. Install the dependencies:
   pip install -r requirements.txt

2. Start the server:
   uvicorn main:app --host 0.0.0.0 --port 8080 --reload

Access http://localhost:8080 to open the UI.
Access http://localhost:8080/docs for the Swagger API explorer.

## Environment variables

  ELBE_INITVM_DIR   Path to initvm directory   (default: /workspace/initvm)
  ELBE_BIN          Path to elbe binary        (default: elbe)
  ELBE_SOAP_HOST    SOAP daemon host           (default: localhost)
  ELBE_SOAP_PORT    SOAP daemon port           (default: 7587)
  ELBE_SOAP_USER    SOAP daemon user           (default: root)
  ELBE_SOAP_PASS    SOAP daemon password       (default: foo)
  ELBE_UPLOAD_DIR   Directory for XML uploads  (default: /workspace/uploads)
