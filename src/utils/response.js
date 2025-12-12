export function success(res, data, status = 200) {
  res.status(status).json(data);
}

export function error(res, message, status = 400) {
  res.status(status).json({ error: message });
}

export function created(res, data) {
  res.status(201).json(data);
}

export function noContent(res) {
  res.status(204).send();
}
