# Bot de tienda para Telegram

Bot para productos digitales autorizados con catálogo, inventario cifrado, compras con saldo y recargas manuales revisadas por el propietario.

## Requisitos

- Node.js 22.13 o superior.
- Un bot creado con BotFather.
- El ID numérico de Telegram del propietario.

## Configuración en Windows

1. Ten listo tu token de BotFather y mantenlo privado. No lo publiques ni lo envíes a nadie.
2. Copia `.env.example` a `.env`.
3. Configura `TOKEN` con el token nuevo y conserva el `OWNER_ID` numérico correcto.
4. Completa solo los métodos de pago que realmente aceptarás: `BINANCE_PAY_ID` y opcionalmente `BINANCE_PAY_NAME`, `BEP20_ADDRESS` y `YAPE_PLIN`. Si una variable queda vacía, ese método no aparecerá en el menú.
5. Opcionalmente configura `SUPPORT_URL`, `CHANNEL_URL` y `STORE_NAME`.
   Para mostrar un GIF en `/start` o `/menu`, define `WELCOME_GIF` con un `file_id` de Telegram o una URL pública directa a un GIF/animación. Si se deja vacío, el bot usa una bienvenida visual sin animación.
   Para usar emojis personalizados de Telegram Premium, escribe `/emojiid` en el bot como propietario y envíale un emoji Premium. Copia el ID que devuelve en `PREMIUM_EMOJI_FIRE`, `PREMIUM_EMOJI_GEM` o `PREMIUM_EMOJI_STAR` dentro de `.env`. Si están vacíos, se muestran emojis estándar.
6. Genera una clave de cifrado de 32 bytes:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Guarda el resultado en `ENCRYPTION_KEY` dentro de `.env`. Si se pierde esta clave, no se podrá recuperar el inventario cifrado.

7. Instala dependencias y arranca el bot:

   ```powershell
   npm.cmd install
   npm.cmd start
   ```

## Subir a un repositorio privado de GitHub

1. Instala Git para Windows e inicia sesión en GitHub desde Git Credential Manager.
2. Crea un repositorio **Private** en GitHub llamado `telegram-digital-shop` (sin README, licencia ni `.gitignore` iniciales).
3. Desde PowerShell, abre esta carpeta y ejecuta:

   ```powershell
   git init -b main
   git add .gitignore .env.example README.md bot.js package.json package-lock.json
   git status --short
   ```

   Antes de continuar, comprueba que `.env`, `data/` y `node_modules/` no aparezcan en la lista.

4. Crea el primer commit y conecta el repositorio privado:

   ```powershell
   git commit -m "Prepare Telegram shop bot"
   git remote add origin https://github.com/TU-USUARIO/telegram-digital-shop.git
   git push -u origin main
   ```

No agregues `.env`, la base de datos ni inventario al repositorio, aunque sea privado. El archivo `.gitignore` los excluye; configura los secretos por separado en el equipo o servicio donde ejecutes el bot.

## Uso

- Clientes: `/start`, luego usan los botones de tienda, recarga, historial, idioma, soporte y canal.
- Propietario: `/admin` para crear productos, cambiar precios, agregar o quitar inventario, revisar existencias, pausar productos o eliminar productos duplicados sin ventas.
- El catálogo muestra 24 productos por página en una cuadrícula de tres columnas. El nombre del producto puede incluir un emoji.
- Al comprar, el cliente escribe cuántas cuentas desea; el bot calcula el total, permite reservar la cantidad por 5 minutos y la devuelve toda al inventario si se cancela o vence la reserva. El máximo por pedido es 50 unidades.
- En `/admin` → **Quitar stock**, el propietario escribe cuántas unidades desea retirar y confirma antes de eliminarlas.
- En `/admin` → **Eliminar producto**, puedes borrar permanentemente un producto duplicado y sus unidades disponibles. Requiere confirmación y solo se permite si no tiene ventas ni reservas activas; los productos con historial se pueden ocultar con **Activar / pausar**.
- Al confirmar una carga con unidades nuevas, el bot avisa a todos los usuarios registrados que ya iniciaron el bot e incluye un botón para abrir la tienda. El panel muestra cuántos avisos se entregaron y cuántos fallaron.
- El menú principal y las pantallas de compra usan botones inline, tarjetas con formato y navegación paginada; `/menu` vuelve a mostrar la portada.
- Para cargar productos digitales autorizados, elige **Agregar inventario** y envía un archivo `.txt` UTF-8 con una unidad por línea, o pega varias unidades en un mensaje. El bot muestra una vista previa y no guarda nada hasta que confirmes; puedes cancelar con el botón o con `/cancel`.
- Las importaciones admiten archivos TXT de hasta 2 MB y 5,000 líneas con contenido. Se omiten duplicados ya registrados (incluidas unidades vendidas) y repetidos dentro de la misma carga. El reporte muestra líneas recibidas, unidades nuevas y duplicados omitidos.
- El bot cifra cada unidad antes de guardarla y conserva una huella SHA-256 para reconocer duplicados sin almacenar el contenido en texto plano. **No cambies ni pierdas `ENCRYPTION_KEY`**, o no podrás descifrar el inventario existente.
- **Ver inventario** muestra unidades disponibles, vendidas y registradas para cada producto.
- Las recargas muestran instrucciones distintas para cada método y solo se acreditan cuando el propietario revisa y aprueba el comprobante.

El diseño toma como referencia las capturas proporcionadas. La tienda debe ofrecer únicamente productos o suscripciones autorizados para reventa; no cargues contraseñas ni accesos compartidos sin permiso del proveedor. Las compras y aprobaciones se registran en SQLite dentro de `data/`; protege esa carpeta y el archivo `.env`.
