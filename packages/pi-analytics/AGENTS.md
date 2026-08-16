# Pi Analytics Guidelines

- Publish a fresh active marker before creating its generation directory during lock-free rotation.
- Revalidate the active marker after reads and writes, and reread it before deleting each obsolete generation.
- Cover concurrent initialization and Clear so they cannot orphan data or delete another process's newly active generation.
