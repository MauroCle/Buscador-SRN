# Configuración

## Reportes de errores

Los reportes enviados desde la app se guardan como texto en `data/reports.log`.
No hay panel de administración: para revisarlos, abre ese archivo o espera el
resumen semanal por correo.

El servidor bloquea el acceso HTTP a `/data/`, así que el archivo no se puede
descargar desde el navegador.

## Resumen semanal por Gmail

El servidor envía un resumen con los reportes pendientes **todos los lunes a las
09:00 (hora local)**. Si el servidor estaba apagado a esa hora, envía el resumen
pendiente la siguiente vez que se inicie. Si el envío falla, lo reintenta una
hora después.

### 1. Contraseña de aplicación de Gmail

1. Entra en tu cuenta de Google → **Seguridad**.
2. Activa la **verificación en dos pasos** (si no está activa).
3. En **Contraseñas de aplicaciones**, crea una nueva (nombre: `Buscador SRN`).
4. Copia la contraseña de 16 caracteres (se muestra con espacios; cópiala tal cual).

### 2. Variables de entorno

Configura estas variables antes de arrancar `node server.js`:

| Variable | Valor | Obligatoria |
| --- | --- | --- |
| `SMTP_USER` | Tu correo de Gmail | Sí |
| `SMTP_PASS` | Contraseña de aplicación de 16 caracteres | Sí |
| `REPORT_TO` | Correo que recibe el resumen (tu Gmail) | Sí |
| `SMTP_FROM` | Remitente; por defecto `SMTP_USER` | No |
| `SMTP_HOST` | `smtp.gmail.com` por defecto | No |
| `SMTP_PORT` | `465` por defecto (TLS implícito) | No |

Ejemplo en PowerShell para dejarlas guardadas en el usuario:

```powershell
setx SMTP_USER "tu-correo@gmail.com"
setx SMTP_PASS "xxxx xxxx xxxx xxxx"
setx REPORT_TO "tu-correo@gmail.com"
```

Después cierra y vuelve a abrir la terminal, y arranca el servidor:

```powershell
node server.js
```

Si solo quieres probar en la sesión actual:

```powershell
$env:SMTP_USER = "tu-correo@gmail.com"
$env:SMTP_PASS = "xxxx xxxx xxxx xxxx"
$env:REPORT_TO = "tu-correo@gmail.com"
node server.js
```

Al iniciar verás un mensaje con la fecha del próximo resumen. Si falta
`SMTP_USER` o `SMTP_PASS`, verás que el resumen está desactivado; los reportes
se seguirán guardando en `data/reports.log` igualmente.

## Límites

- Máximo 5 reportes por hora y dirección IP.
- Máximo 16 KB por reporte (asunto 160 caracteres, detalles 4000).
- Solo texto: no se aceptan capturas ni archivos adjuntos.
