import axios from 'axios';

let getToken = null;
export const setTokenGetter = (fn) => {
  getToken = fn;
};

export const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use(async (cfg) => {
  const token = getToken ? await getToken() : null;
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

/** The server's error message, or a plain fallback. */
export const errorText = (err) =>
  err?.response?.data?.error?.message || (err?.response ? `Request failed (${err.response.status})` : 'Network error; check your connection');

export const errorCode = (err) => err?.response?.data?.error?.code || null;
