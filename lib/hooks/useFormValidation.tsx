/**
 * useFormValidation - 表单验证 Hook
 * 
 * 功能:
 * - 实时验证
 * - 字段级错误
 * - 提交时验证
 * - 自定义验证规则
 * - 防抖输入
 */

'use client'
/* eslint-disable react-hooks/preserve-manual-memoization */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'

// ============================================
// 类型定义
// ============================================

export type ValidationRule<T = string> = {
  validate: (value: T, formData?: Record<string, unknown>) => boolean | Promise<boolean>
  message: string
}

export type FieldConfig<T = string> = {
  initialValue: T
  rules?: ValidationRule<T>[]
  validateOnChange?: boolean
  validateOnBlur?: boolean
  debounceMs?: number
}

export type FormConfig<T extends Record<string, unknown>> = {
  [K in keyof T]: FieldConfig<T[K]>
}

export type FieldState<T = string> = {
  value: T
  error: string | null
  touched: boolean
  dirty: boolean
  validating: boolean
}

export type FormState<T extends Record<string, unknown>> = {
  [K in keyof T]: FieldState<T[K]>
}

// ============================================
// 内置验证规则
// ============================================

export const validators = {
  required: (message = '此字段为必填'): ValidationRule<string> => ({
    validate: (value) => value.trim().length > 0,
    message,
  }),

  minLength: (min: number, message?: string): ValidationRule<string> => ({
    validate: (value) => value.length >= min,
    message: message || `最少 ${min} 个字符`,
  }),

  maxLength: (max: number, message?: string): ValidationRule<string> => ({
    validate: (value) => value.length <= max,
    message: message || `最多 ${max} 个字符`,
  }),

  email: (message = '请输入有效的邮箱地址'): ValidationRule<string> => ({
    validate: (value) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    message,
  }),

  url: (message = '请输入有效的 URL'): ValidationRule<string> => ({
    validate: (value) => !value || /^https?:\/\/.+/.test(value),
    message,
  }),

  pattern: (regex: RegExp, message = '格式不正确'): ValidationRule<string> => ({
    validate: (value) => !value || regex.test(value),
    message,
  }),

  match: (fieldName: string, message?: string): ValidationRule<string> => ({
    validate: (value, formData) => value === formData?.[fieldName],
    message: message || '两次输入不一致',
  }),

  min: (min: number, message?: string): ValidationRule<number> => ({
    validate: (value) => value >= min,
    message: message || `不能小于 ${min}`,
  }),

  max: (max: number, message?: string): ValidationRule<number> => ({
    validate: (value) => value <= max,
    message: message || `不能大于 ${max}`,
  }),

  // 中文手机号
  phone: (message = '请输入有效的手机号'): ValidationRule<string> => ({
    validate: (value) => !value || /^1[3-9]\d{9}$/.test(value),
    message,
  }),

  // 用户名 (字母数字下划线)
  username: (message = '用户名只能包含字母、数字和下划线'): ValidationRule<string> => ({
    validate: (value) => !value || /^[a-zA-Z0-9_]+$/.test(value),
    message,
  }),

  // 密码强度
  password: (message = '密码必须包含至少8个字符，包括字母和数字'): ValidationRule<string> => ({
    validate: (value) => !value || /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d@$!%*#?&]{8,}$/.test(value),
    message,
  }),
}

// ============================================
// Hook 实现
// ============================================

export function useFormValidation<T extends Record<string, unknown>>(
  config: FormConfig<T>
) {
  // 初始化表单状态
  const initialState = useMemo(() => {
    const state: Record<string, FieldState<unknown>> = {}
    for (const [key, fieldConfig] of Object.entries(config)) {
      state[key] = {
        value: fieldConfig.initialValue,
        error: null,
        touched: false,
        dirty: false,
        validating: false,
      }
    }
    return state as FormState<T>
  }, [])

  const [formState, setFormState] = useState<FormState<T>>(initialState)
  const debounceTimers = useRef<Record<string, NodeJS.Timeout>>({})

  // 获取当前表单数据
  const getFormData = useCallback((): T => {
    const data: Record<string, unknown> = {}
    for (const key of Object.keys(formState)) {
      data[key] = formState[key].value
    }
    return data as T
  }, [formState])

  // 验证单个字段
  const validateField = useCallback(async <K extends keyof T>(
    fieldName: K,
    value: T[K]
  ): Promise<string | null> => {
    const fieldConfig = config[fieldName]
    if (!fieldConfig.rules || fieldConfig.rules.length === 0) {
      return null
    }

    const formData = getFormData()
    
    for (const rule of fieldConfig.rules) {
      const isValid = await rule.validate(value as never, formData)
      if (!isValid) {
        return rule.message
      }
    }

    return null
  }, [config, getFormData])

  // 设置字段值
  const setFieldValue = useCallback(<K extends keyof T>(
    fieldName: K,
    value: T[K],
    shouldValidate = true
  ) => {
    const fieldConfig = config[fieldName]
    
    setFormState(prev => ({
      ...prev,
      [fieldName]: {
        ...prev[fieldName],
        value,
        dirty: value !== fieldConfig.initialValue,
        validating: shouldValidate && (fieldConfig.validateOnChange ?? true),
      },
    }))

    // 清除之前的防抖计时器
    if (debounceTimers.current[fieldName as string]) {
      clearTimeout(debounceTimers.current[fieldName as string])
    }

    // 验证 (带防抖)
    if (shouldValidate && (fieldConfig.validateOnChange ?? true)) {
      const debounceMs = fieldConfig.debounceMs ?? 300

      debounceTimers.current[fieldName as string] = setTimeout(async () => {
        const error = await validateField(fieldName, value)
        setFormState(prev => ({
          ...prev,
          [fieldName]: {
            ...prev[fieldName],
            error,
            validating: false,
          },
        }))
      }, debounceMs)
    }
  }, [config, validateField])

  // 设置字段触摸状态
  const setFieldTouched = useCallback(<K extends keyof T>(
    fieldName: K,
    touched = true,
    shouldValidate = true
  ) => {
    const fieldConfig = config[fieldName]
    
    setFormState(prev => ({
      ...prev,
      [fieldName]: {
        ...prev[fieldName],
        touched,
      },
    }))

    // 失焦时验证
    if (shouldValidate && touched && (fieldConfig.validateOnBlur ?? true)) {
      validateField(fieldName, formState[fieldName].value as T[K]).then(error => {
        setFormState(prev => ({
          ...prev,
          [fieldName]: {
            ...prev[fieldName],
            error,
          },
        }))
      })
    }
  }, [config, formState, validateField])

  // 设置字段错误
  const setFieldError = useCallback(<K extends keyof T>(
    fieldName: K,
    error: string | null
  ) => {
    setFormState(prev => ({
      ...prev,
      [fieldName]: {
        ...prev[fieldName],
        error,
      },
    }))
  }, [])

  // 验证所有字段
  const validateForm = useCallback(async (): Promise<boolean> => {
    const errors: Record<string, string | null> = {}
    let isValid = true

    for (const fieldName of Object.keys(config) as Array<keyof T>) {
      const error = await validateField(fieldName, formState[fieldName].value as T[typeof fieldName])
      errors[fieldName as string] = error
      if (error) {
        isValid = false
      }
    }

    setFormState(prev => {
      const newState = { ...prev }
      for (const fieldName of Object.keys(errors)) {
        newState[fieldName as keyof T] = {
          ...newState[fieldName as keyof T],
          error: errors[fieldName],
          touched: true,
        }
      }
      return newState
    })

    return isValid
  }, [config, formState, validateField])

  // 重置表单
  const resetForm = useCallback(() => {
    setFormState(initialState)
  }, [initialState])

  // 获取字段 props (用于绑定到 input)
  const getFieldProps = useCallback(<K extends keyof T>(fieldName: K) => ({
    value: formState[fieldName].value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFieldValue(fieldName, e.target.value as T[K])
    },
    onBlur: () => {
      setFieldTouched(fieldName, true)
    },
    'aria-invalid': !!formState[fieldName].error,
  }), [formState, setFieldValue, setFieldTouched])

  // 计算表单状态
  const isValid = useMemo(() => {
    return Object.values(formState).every(field => !field.error)
  }, [formState])

  const isDirty = useMemo(() => {
    return Object.values(formState).some(field => field.dirty)
  }, [formState])

  const isValidating = useMemo(() => {
    return Object.values(formState).some(field => field.validating)
  }, [formState])

  // 清理定时器
  useEffect(() => {
    return () => {
      Object.values(debounceTimers.current).forEach(clearTimeout)
    }
  }, [])

  return {
    formState,
    setFieldValue,
    setFieldTouched,
    setFieldError,
    validateField,
    validateForm,
    resetForm,
    getFieldProps,
    getFormData,
    isValid,
    isDirty,
    isValidating,
  }
}

// ============================================
// 辅助组件
// ============================================

export type FieldErrorProps = {
  error: string | null
  touched: boolean
  showOnTouched?: boolean
}

/**
 * 字段错误提示组件 (示例)
 */
export function FieldError({ error, touched, showOnTouched = true }: FieldErrorProps) {
  if (!error || (showOnTouched && !touched)) {
    return null
  }

  return (
    <span
      style={{
        color: '#ff7c7c',
        fontSize: '12px',
        marginTop: '4px',
        display: 'block',
      }}
    >
      {error}
    </span>
  )
}

export default useFormValidation
